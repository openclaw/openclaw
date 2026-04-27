export declare function isValidInboundPathRootPattern(value: string): boolean;
export declare function normalizeInboundPathRoots(roots?: readonly string[]): string[];
export declare function mergeInboundPathRoots(...rootsLists: Array<readonly string[] | undefined>): string[];
export declare function isInboundPathAllowed(params: {
    filePath: string;
    roots: readonly string[];
    fallbackRoots?: readonly string[];
}): boolean;
