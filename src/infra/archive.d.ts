import JSZip from "jszip";
export type ArchiveKind = "tar" | "zip";
export type ArchiveLogger = {
    info?: (message: string) => void;
    warn?: (message: string) => void;
};
export type ArchiveExtractLimits = {
    /**
     * Max archive file bytes (compressed).
     */
    maxArchiveBytes?: number;
    /** Max number of extracted entries (files + dirs). */
    maxEntries?: number;
    /** Max extracted bytes (sum of all files). */
    maxExtractedBytes?: number;
    /** Max extracted bytes for a single file entry. */
    maxEntryBytes?: number;
};
export { ArchiveSecurityError, type ArchiveSecurityErrorCode } from "./archive-staging.js";
export { mergeExtractedTreeIntoDestination, prepareArchiveDestinationDir, prepareArchiveOutputPath, withStagedArchiveDestination, } from "./archive-staging.js";
/** @internal */
export declare const DEFAULT_MAX_ARCHIVE_BYTES_ZIP: number;
/** @internal */
export declare const DEFAULT_MAX_ENTRIES = 50000;
/** @internal */
export declare const DEFAULT_MAX_EXTRACTED_BYTES: number;
/** @internal */
export declare const DEFAULT_MAX_ENTRY_BYTES: number;
export declare const ARCHIVE_LIMIT_ERROR_CODE: {
    readonly ARCHIVE_SIZE_EXCEEDS_LIMIT: "archive-size-exceeds-limit";
    readonly ENTRY_COUNT_EXCEEDS_LIMIT: "archive-entry-count-exceeds-limit";
    readonly ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT: "archive-entry-extracted-size-exceeds-limit";
    readonly EXTRACTED_SIZE_EXCEEDS_LIMIT: "archive-extracted-size-exceeds-limit";
};
export type ArchiveLimitErrorCode = (typeof ARCHIVE_LIMIT_ERROR_CODE)[keyof typeof ARCHIVE_LIMIT_ERROR_CODE];
export declare class ArchiveLimitError extends Error {
    readonly code: ArchiveLimitErrorCode;
    constructor(code: ArchiveLimitErrorCode);
}
export declare function resolveArchiveKind(filePath: string): ArchiveKind | null;
type ResolvePackedRootDirOptions = {
    rootMarkers?: string[];
};
export declare function resolvePackedRootDir(extractDir: string, options?: ResolvePackedRootDirOptions): Promise<string>;
export declare function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T>;
/** @internal */
export declare function readZipCentralDirectoryEntryCount(buffer: Buffer | Uint8Array): number | null;
export declare function loadZipArchiveWithPreflight(buffer: Buffer | Uint8Array, limits?: ArchiveExtractLimits): Promise<JSZip>;
export type TarEntryInfo = {
    path: string;
    type: string;
    size: number;
};
export declare function createTarEntryPreflightChecker(params: {
    rootDir: string;
    stripComponents?: number;
    limits?: ArchiveExtractLimits;
    escapeLabel?: string;
}): (entry: TarEntryInfo) => void;
export declare function extractArchive(params: {
    archivePath: string;
    destDir: string;
    timeoutMs: number;
    kind?: ArchiveKind;
    stripComponents?: number;
    tarGzip?: boolean;
    limits?: ArchiveExtractLimits;
    logger?: ArchiveLogger;
}): Promise<void>;
export declare function fileExists(filePath: string): Promise<boolean>;
export declare function readJsonFile<T>(filePath: string): Promise<T>;
