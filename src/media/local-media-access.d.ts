export type LocalMediaAccessErrorCode = "path-not-allowed" | "invalid-root" | "invalid-file-url" | "network-path-not-allowed" | "unsafe-bypass" | "not-found" | "invalid-path" | "not-file";
export declare class LocalMediaAccessError extends Error {
    code: LocalMediaAccessErrorCode;
    constructor(code: LocalMediaAccessErrorCode, message: string, options?: ErrorOptions);
}
export declare function getDefaultLocalRoots(): readonly string[];
export declare function assertLocalMediaAllowed(mediaPath: string, localRoots: readonly string[] | "any" | undefined): Promise<void>;
