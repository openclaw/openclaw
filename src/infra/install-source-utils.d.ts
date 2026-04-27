export type NpmSpecResolution = {
    name?: string;
    version?: string;
    resolvedSpec?: string;
    integrity?: string;
    shasum?: string;
    resolvedAt?: string;
};
export type NpmResolutionFields = {
    resolvedName?: string;
    resolvedVersion?: string;
    resolvedSpec?: string;
    integrity?: string;
    shasum?: string;
    resolvedAt?: string;
};
export declare function buildNpmResolutionFields(resolution?: NpmSpecResolution): NpmResolutionFields;
export declare function resolveNpmSpecMetadata(params: {
    spec: string;
    timeoutMs?: number;
}): Promise<{
    ok: true;
    metadata: NpmSpecResolution;
} | {
    ok: false;
    error: string;
}>;
export type NpmIntegrityDrift = {
    expectedIntegrity: string;
    actualIntegrity: string;
};
export declare function withTempDir<T>(prefix: string, fn: (tmpDir: string) => Promise<T>): Promise<T>;
export declare function resolveArchiveSourcePath(archivePath: string): Promise<{
    ok: true;
    path: string;
} | {
    ok: false;
    error: string;
}>;
export declare function packNpmSpecToArchive(params: {
    spec: string;
    timeoutMs: number;
    cwd: string;
}): Promise<{
    ok: true;
    archivePath: string;
    metadata: NpmSpecResolution;
} | {
    ok: false;
    error: string;
}>;
