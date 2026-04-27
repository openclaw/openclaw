export type MediaReferenceErrorCode = "invalid-path" | "path-not-allowed";
export declare class MediaReferenceError extends Error {
    code: MediaReferenceErrorCode;
    constructor(code: MediaReferenceErrorCode, message: string, options?: ErrorOptions);
}
export type InboundMediaReference = {
    id: string;
    normalizedSource: string;
    physicalPath: string;
    sourceType: "uri" | "path";
};
export declare function normalizeMediaReferenceSource(source: string): string;
export type MediaReferenceSourceInfo = {
    hasScheme: boolean;
    hasUnsupportedScheme: boolean;
    isDataUrl: boolean;
    isFileUrl: boolean;
    isHttpUrl: boolean;
    isMediaStoreUrl: boolean;
    looksLikeWindowsDrivePath: boolean;
};
export declare function classifyMediaReferenceSource(source: string, options?: {
    allowDataUrl?: boolean;
}): MediaReferenceSourceInfo;
export declare function resolveInboundMediaReference(source: string): Promise<InboundMediaReference | null>;
export declare function resolveMediaReferenceLocalPath(source: string): Promise<string>;
