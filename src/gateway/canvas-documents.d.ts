export type CanvasDocumentKind = "html_bundle" | "url_embed" | "document" | "image" | "video_asset";
export type CanvasDocumentAsset = {
    logicalPath: string;
    sourcePath: string;
    contentType?: string;
};
export type CanvasDocumentEntrypoint = {
    type: "html";
    value: string;
} | {
    type: "path";
    value: string;
} | {
    type: "url";
    value: string;
};
export type CanvasDocumentCreateInput = {
    id?: string;
    kind: CanvasDocumentKind;
    title?: string;
    preferredHeight?: number;
    entrypoint?: CanvasDocumentEntrypoint;
    assets?: CanvasDocumentAsset[];
    surface?: "assistant_message" | "tool_card" | "sidebar";
};
export type CanvasDocumentManifest = {
    id: string;
    kind: CanvasDocumentKind;
    title?: string;
    preferredHeight?: number;
    createdAt: string;
    entryUrl: string;
    localEntrypoint?: string;
    externalUrl?: string;
    surface?: "assistant_message" | "tool_card" | "sidebar";
    assets: Array<{
        logicalPath: string;
        contentType?: string;
    }>;
};
export type CanvasDocumentResolvedAsset = {
    logicalPath: string;
    contentType?: string;
    url: string;
    localPath: string;
};
export declare function resolveCanvasRootDir(rootDir?: string, stateDir?: string): string;
export declare function resolveCanvasDocumentsDir(rootDir?: string, stateDir?: string): string;
export declare function resolveCanvasDocumentDir(documentId: string, options?: {
    rootDir?: string;
    stateDir?: string;
}): string;
export declare function buildCanvasDocumentEntryUrl(documentId: string, entrypoint: string): string;
export declare function buildCanvasDocumentAssetUrl(documentId: string, logicalPath: string): string;
export declare function resolveCanvasHttpPathToLocalPath(requestPath: string, options?: {
    rootDir?: string;
    stateDir?: string;
}): string | null;
export declare function createCanvasDocument(input: CanvasDocumentCreateInput, options?: {
    stateDir?: string;
    workspaceDir?: string;
    canvasRootDir?: string;
}): Promise<CanvasDocumentManifest>;
export declare function loadCanvasDocumentManifest(documentId: string, options?: {
    stateDir?: string;
    canvasRootDir?: string;
}): Promise<CanvasDocumentManifest | null>;
export declare function resolveCanvasDocumentAssets(manifest: CanvasDocumentManifest, options?: {
    baseUrl?: string;
    stateDir?: string;
    canvasRootDir?: string;
}): CanvasDocumentResolvedAsset[];
