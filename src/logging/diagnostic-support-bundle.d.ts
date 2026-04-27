export type DiagnosticSupportBundleFile = {
    path: string;
    mediaType: string;
    content: string;
};
export type DiagnosticSupportBundleContent = {
    path: string;
    mediaType: string;
    bytes: number;
};
export declare function supportBundleByteLength(content: string): number;
export declare function jsonSupportBundleFile(pathName: string, value: unknown): DiagnosticSupportBundleFile;
export declare function jsonlSupportBundleFile(pathName: string, lines: readonly string[]): DiagnosticSupportBundleFile;
export declare function textSupportBundleFile(pathName: string, content: string): DiagnosticSupportBundleFile;
export declare function supportBundleContents(files: readonly DiagnosticSupportBundleFile[]): DiagnosticSupportBundleContent[];
export declare function assertSafeBundleRelativePath(pathName: string): string;
export declare function prepareSupportBundleDirectory(outputDir: string): void;
export declare function resolveSupportBundleFilePath(outputDir: string, pathName: string): string;
export declare function writeSupportBundleFile(outputDir: string, file: DiagnosticSupportBundleFile): void;
export declare function copySupportBundleFile(params: {
    outputDir: string;
    sourceFile: string;
    path: string;
}): DiagnosticSupportBundleContent;
export declare function writeSupportBundleDirectory(params: {
    outputDir: string;
    files: readonly DiagnosticSupportBundleFile[];
}): DiagnosticSupportBundleContent[];
export declare function writeSupportBundleZip(params: {
    outputPath: string;
    files: readonly DiagnosticSupportBundleFile[];
    compressionLevel?: number;
}): Promise<number>;
