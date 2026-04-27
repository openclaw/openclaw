export type ArchiveSecurityErrorCode = "destination-not-directory" | "destination-symlink" | "destination-symlink-traversal";
export declare class ArchiveSecurityError extends Error {
    code: ArchiveSecurityErrorCode;
    constructor(code: ArchiveSecurityErrorCode, message: string, options?: ErrorOptions);
}
export declare function prepareArchiveDestinationDir(destDir: string): Promise<string>;
export declare function prepareArchiveOutputPath(params: {
    destinationDir: string;
    destinationRealDir: string;
    relPath: string;
    outPath: string;
    originalPath: string;
    isDirectory: boolean;
}): Promise<void>;
export declare function withStagedArchiveDestination<T>(params: {
    destinationRealDir: string;
    run: (stagingDir: string) => Promise<T>;
}): Promise<T>;
export declare function mergeExtractedTreeIntoDestination(params: {
    sourceDir: string;
    destinationDir: string;
    destinationRealDir: string;
}): Promise<void>;
export declare function createArchiveSymlinkTraversalError(originalPath: string): ArchiveSecurityError;
