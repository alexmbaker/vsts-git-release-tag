import * as vsts from "vso-node-api";
import * as bld from "vso-node-api/BuildApi";
import * as git from "vso-node-api/GitApi";
import * as bldi from "vso-node-api/Interfaces/BuildInterfaces";
import * as giti from "vso-node-api/Interfaces/GitInterfaces";
import * as tl from "vsts-task-lib/task";
import IArtifactData from "./IArtifactData";

export abstract class GitRefCreator {
    readonly defaultSearchPattern: string = "\\s+";
    readonly defaultRegexFlags: string = "g";
    readonly defaultReplacePattern: string = "";
    readonly permissionTemplate: string = "You must grant the build account access to permission: ";

    protected abstract get refName(): string;

    protected constructor() {
        this.printVersion();
    }

    public async run() {
        try {

            let token: string = tl.getEndpointAuthorizationParameter("SystemVssConnection", "AccessToken", false);
            let collectionUrl: string = tl.getEndpointUrl("SystemVssConnection", false).replace(".vsrm.visualstudio.com", ".visualstudio.com"); // need build
            let authHandler = vsts.getPersonalAccessTokenHandler(token);
            let connect = new vsts.WebApi(collectionUrl, authHandler);

            let gitapi: git.IGitApi = connect.getGitApi();
            let bldapi: bld.IBuildApi = connect.getBuildApi();

            let artifactData: IArtifactData[] = await this.getAllGitArtifacts(bldapi);

            if (artifactData.length === 0) {
                tl.warning("No TfsGit artifacts found.");
            }

            for (let artifact of artifactData) {
                await this.processArtifact(artifact, gitapi);
            }
        } catch (err) {
            tl.setResult(tl.TaskResult.Failed, err.message);
        }
    }

    protected generateRef(releaseName: string, prefix: string): string {
        let searchRegex: string = this.getInputOrDefault("searchRegex", this.defaultSearchPattern);
        let regexFlags: string = this.getInputOrDefault("regexFlags", this.defaultRegexFlags);
        let replacePattern: string = this.getInputOrDefault("replacePattern", this.defaultReplacePattern);

        tl.debug(`Search Regex: '${searchRegex}', Replace Pattern: '${replacePattern}', flags: '${regexFlags}'`);

        let regex: RegExp = new RegExp(searchRegex, regexFlags);

        let refName: string = releaseName.replace(regex, replacePattern);
        refName = `${prefix}${refName}`;

        tl.debug(`RefName: '${refName}'`);

        return refName;
    }

    private getInputOrDefault(inputName: string, defaultValue: string): string {
        let value: string = tl.getInput(inputName, false);
        if (value != null) {
            return value;
        }

        return defaultValue;
    }

    private async getAllGitArtifacts(bldapi: bld.IBuildApi): Promise<IArtifactData[]> {
        let artifactNames: IArtifactData[] = [];
        let regexp: RegExp = new RegExp("RELEASE\.ARTIFACTS\.(.*)\.REPOSITORY\.PROVIDER", "gi");

        for (let variableInfo of tl.getVariables()) {
            let match: RegExpExecArray = regexp.exec(variableInfo.name);
            if (match === null) {
                tl.debug(`No match for variable: ${variableInfo.name}`);
                continue;
            }

            if (variableInfo.value !== "TfsGit" && variableInfo.value !== "Git") {
                tl.debug(`Matching variable:  ${variableInfo.name}, but artifact type: ${variableInfo.value}`);
                continue;
            }

            let name: string = match[1];
            tl.debug(`Getting repository id for artifact: ${name}`);
            let repositoryId: string = await this.getRepositoryId(bldapi, name);
            if (repositoryId == null) {
                continue; // Error already logged
            }

            let artifact: IArtifactData = {
                "name": name,
                "commit": tl.getVariable(`RELEASE.ARTIFACTS.${name}.SOURCEVERSION`),
                "repositoryId": repositoryId,
            };

            artifactNames.push(artifact);
        }

        return artifactNames;
    }

    //RELEASE.ARTIFACTS.${name}.REPOSITORY_ID new as of 6/2017. Old method needed for a while.
    private async getRepositoryId(bldapi: bld.IBuildApi, name: string): Promise <string> {
        let repositoryId: string = tl.getVariable(`RELEASE.ARTIFACTS.${name}.REPOSITORY_ID`);
        if (repositoryId != null && repositoryId != "") {
            return repositoryId;
        }

        return await this.getRepositoryIdFromBuildNumber(bldapi, name);
    }

    private async getRepositoryIdFromBuildNumber(bldapi: bld.IBuildApi, name: string): Promise <string> {
        let buildidVariable: string = `RELEASE.ARTIFACTS.${name}.BUILDID`;
        let buildid: string = tl.getVariable(buildidVariable);

        if (buildid === null || buildid === "") {
            tl.setResult(tl.TaskResult.Failed, `Unable to get build id from variable: ${buildidVariable}`);
            return null;
        }

        let build: bldi.Build = await bldapi.getBuild(Number(buildid));
        tl.debug(`Got repositoryid: ${build.repository.id}`);
        return build.repository.id;
    }

    protected async processArtifact(artifact: IArtifactData, gitapi: git.IGitApi) {

        tl.debug(`Processing artifact: '${artifact.name}' for ref: ${this.refName} new commit: ${artifact.commit}`);

        let updateResult: giti.GitRefUpdateResult = await this.updateRef(artifact, this.refName, gitapi);
        if (updateResult.success) {
            tl.debug("Ref updated!");
            return;
        }

        // See if there is a matching ref for the same commit. We won't overwrite an existing ref. Done after the update so all refs don't need to be brought back every time.
        if (await this.doesRefExist(artifact, this.refName, gitapi)) {
            return;
        }


        switch (updateResult.updateStatus) {
            case giti.GitRefUpdateStatus.CreateBranchPermissionRequired:
                tl.error(`${this.permissionTemplate}Create Branch`);
                break;
            case giti.GitRefUpdateStatus.CreateTagPermissionRequired:
                tl.error(`${this.permissionTemplate}Create Tag`);
                break;
        }

        tl.error(`If you need to change permissions see: _admin/_versioncontrol?_a=security&repositoryId=${artifact.repositoryId}`);

        tl.setResult(tl.TaskResult.Failed, `Unable to create ref: ${this.refName} UpdateStatus: ${updateResult.updateStatus} RepositoryId: ${updateResult.repositoryId} Commit: ${updateResult.newObjectId}`);
    }
    private async doesRefExist(artifact: IArtifactData, refName: string, gitapi: git.IGitApi): Promise < boolean > {
        let refs: giti.GitRef[] = await gitapi.getRefs(artifact.repositoryId);
        if (refs == null) {
            return false;
        }

        let foundRef: giti.GitRef = refs.find((x) => x.name === refName);
        if (foundRef == null) {
            return false;
        }

        if (foundRef.objectId === artifact.commit) {
            tl.debug("Found matching ref for commit.");
            return true;
        }

        tl.warning(`Ref exists, but on different commit. New commit: ${artifact.commit} Old Commit: ${foundRef.objectId}`);
        return false;
    }
    private async updateRef(artifact: IArtifactData, refName: string, gitapi: git.IGitApi): Promise < giti.GitRefUpdateResult > {
        let ref: giti.GitRefUpdate = {
            "isLocked": false,
            "name": refName,
            "newObjectId": artifact.commit,
            "oldObjectId": "0000000000000000000000000000000000000000",
            "repositoryId": artifact.repositoryId,
        };

        let refArray: giti.GitRefUpdate[] = [ref];
        let updateRefsResult: giti.GitRefUpdateResult[] = await gitapi.updateRefs(refArray, artifact.repositoryId);
        if (updateRefsResult == null || updateRefsResult.length === 0) {
            tl.warning(`No update result returned from updateRefs`);
            return null;
        }

        return updateRefsResult[0];
    }

    private printVersion() {
        try {
            let taskData = require("./task.json");
            console.log(`${taskData.name}: Version: ${taskData.version.Major}.${taskData.version.Minor}.${taskData.version.Patch}`);
        } catch (Err) {
            console.log("Unknown version number");
        }
    }
}