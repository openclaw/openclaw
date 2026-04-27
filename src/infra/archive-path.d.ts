export declare function isWindowsDrivePath(value: string): boolean;
export declare function normalizeArchiveEntryPath(raw: string): string;
export declare function validateArchiveEntryPath(entryPath: string, params?: {
    escapeLabel?: string;
}): void;
export declare function stripArchivePath(entryPath: string, stripComponents: number): string | null;
export declare function resolveArchiveOutputPath(params: {
    rootDir: string;
    relPath: string;
    originalPath: string;
    escapeLabel?: string;
}): string;
