export declare function isPinnedPathHelperSpawnError(error: unknown): boolean;
export declare function runPinnedPathHelper(params: {
    operation: "mkdirp" | "remove";
    rootPath: string;
    relativePath: string;
}): Promise<void>;
