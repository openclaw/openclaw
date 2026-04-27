export declare function unscopedPackageName(name: string): string;
export declare function packageNameMatchesId(packageName: string, id: string): boolean;
export declare function safeDirName(input: string): string;
export declare function safePathSegmentHashed(input: string): string;
export declare function resolveSafeInstallDir(params: {
    baseDir: string;
    id: string;
    invalidNameMessage: string;
    nameEncoder?: (id: string) => string;
}): {
    ok: true;
    path: string;
} | {
    ok: false;
    error: string;
};
export declare function assertCanonicalPathWithinBase(params: {
    baseDir: string;
    candidatePath: string;
    boundaryLabel: string;
}): Promise<void>;
