export declare const DEFAULT_GIT_DISCOVERY_MAX_DEPTH = 12;
export declare function findGitRoot(startDir: string, opts?: {
    maxDepth?: number;
}): string | null;
export declare function resolveGitHeadPath(startDir: string, opts?: {
    maxDepth?: number;
}): string | null;
