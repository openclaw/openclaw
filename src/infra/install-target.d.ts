export declare function resolveCanonicalInstallTarget(params: {
    baseDir: string;
    id: string;
    invalidNameMessage: string;
    boundaryLabel: string;
    nameEncoder?: (id: string) => string;
}): Promise<{
    ok: true;
    targetDir: string;
} | {
    ok: false;
    error: string;
}>;
export declare function ensureInstallTargetAvailable(params: {
    mode: "install" | "update";
    targetDir: string;
    alreadyExistsError: string;
}): Promise<{
    ok: true;
} | {
    ok: false;
    error: string;
}>;
