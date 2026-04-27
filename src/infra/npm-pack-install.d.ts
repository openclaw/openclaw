import { type NpmIntegrityDrift, type NpmSpecResolution } from "./install-source-utils.js";
import { type NpmIntegrityDriftPayload } from "./npm-integrity.js";
export type NpmSpecArchiveInstallFlowResult<TResult extends {
    ok: boolean;
}> = {
    ok: false;
    error: string;
} | {
    ok: true;
    installResult: TResult;
    npmResolution: NpmSpecResolution;
    integrityDrift?: NpmIntegrityDrift;
};
export declare function installFromNpmSpecArchiveWithInstaller<TResult extends {
    ok: boolean;
}, TArchiveInstallParams extends {
    archivePath: string;
}>(params: {
    tempDirPrefix: string;
    spec: string;
    timeoutMs: number;
    expectedIntegrity?: string;
    onIntegrityDrift?: (payload: NpmIntegrityDriftPayload) => boolean | Promise<boolean>;
    warn?: (message: string) => void;
    installFromArchive: (params: TArchiveInstallParams) => Promise<TResult>;
    archiveInstallParams: Omit<TArchiveInstallParams, "archivePath">;
}): Promise<NpmSpecArchiveInstallFlowResult<TResult>>;
export type NpmSpecArchiveFinalInstallResult<TResult extends {
    ok: boolean;
}> = {
    ok: false;
    error: string;
} | Exclude<TResult, {
    ok: true;
}> | (Extract<TResult, {
    ok: true;
}> & {
    npmResolution: NpmSpecResolution;
    integrityDrift?: NpmIntegrityDrift;
});
export declare function finalizeNpmSpecArchiveInstall<TResult extends {
    ok: boolean;
}>(flowResult: NpmSpecArchiveInstallFlowResult<TResult>): NpmSpecArchiveFinalInstallResult<TResult>;
export declare function installFromNpmSpecArchive<TResult extends {
    ok: boolean;
}>(params: {
    tempDirPrefix: string;
    spec: string;
    timeoutMs: number;
    expectedIntegrity?: string;
    onIntegrityDrift?: (payload: NpmIntegrityDriftPayload) => boolean | Promise<boolean>;
    warn?: (message: string) => void;
    installFromArchive: (params: {
        archivePath: string;
    }) => Promise<TResult>;
}): Promise<NpmSpecArchiveInstallFlowResult<TResult>>;
