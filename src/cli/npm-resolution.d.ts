import { type NpmSpecResolution as NpmResolutionMetadata } from "../infra/install-source-utils.js";
export declare function resolvePinnedNpmSpec(params: {
    rawSpec: string;
    pin: boolean;
    resolvedSpec?: string;
}): {
    recordSpec: string;
    pinWarning?: string;
    pinNotice?: string;
};
export declare function mapNpmResolutionMetadata(resolution?: NpmResolutionMetadata): {
    resolvedName?: string;
    resolvedVersion?: string;
    resolvedSpec?: string;
    integrity?: string;
    shasum?: string;
    resolvedAt?: string;
};
export declare function buildNpmInstallRecordFields(params: {
    spec: string;
    installPath: string;
    version?: string;
    resolution?: NpmResolutionMetadata;
}): {
    source: "npm";
    spec: string;
    installPath: string;
    version?: string;
    resolvedName?: string;
    resolvedVersion?: string;
    resolvedSpec?: string;
    integrity?: string;
    shasum?: string;
    resolvedAt?: string;
};
export declare function resolvePinnedNpmInstallRecord(params: {
    rawSpec: string;
    pin: boolean;
    installPath: string;
    version?: string;
    resolution?: NpmResolutionMetadata;
    log: (message: string) => void;
    warn: (message: string) => void;
}): ReturnType<typeof buildNpmInstallRecordFields>;
export declare function resolvePinnedNpmInstallRecordForCli(rawSpec: string, pin: boolean, installPath: string, version: string | undefined, resolution: NpmResolutionMetadata | undefined, log: (message: string) => void, warnFormat: (message: string) => string): ReturnType<typeof buildNpmInstallRecordFields>;
export declare function logPinnedNpmSpecMessages(pinInfo: {
    pinWarning?: string;
    pinNotice?: string;
}, log: (message: string) => void, logWarn: (message: string) => void): void;
