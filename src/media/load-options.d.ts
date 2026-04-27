export type OutboundMediaReadFile = (filePath: string) => Promise<Buffer>;
export type OutboundMediaAccess = {
    localRoots?: readonly string[];
    readFile?: OutboundMediaReadFile;
    /** Agent workspace directory for resolving relative MEDIA: paths. */
    workspaceDir?: string;
};
export type OutboundMediaLoadParams = {
    maxBytes?: number;
    mediaAccess?: OutboundMediaAccess;
    mediaLocalRoots?: readonly string[] | "any";
    mediaReadFile?: OutboundMediaReadFile;
    proxyUrl?: string;
    fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    requestInit?: RequestInit;
    trustExplicitProxyDns?: boolean;
    optimizeImages?: boolean;
    /** Agent workspace directory for resolving relative MEDIA: paths. */
    workspaceDir?: string;
};
export type OutboundMediaLoadOptions = {
    maxBytes?: number;
    localRoots?: readonly string[] | "any";
    readFile?: (filePath: string) => Promise<Buffer>;
    proxyUrl?: string;
    fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    requestInit?: RequestInit;
    trustExplicitProxyDns?: boolean;
    hostReadCapability?: boolean;
    optimizeImages?: boolean;
    /** Agent workspace directory for resolving relative MEDIA: paths. */
    workspaceDir?: string;
};
export declare function resolveOutboundMediaLocalRoots(mediaLocalRoots?: readonly string[] | "any"): readonly string[] | "any" | undefined;
export declare function resolveOutboundMediaAccess(params?: {
    mediaAccess?: OutboundMediaAccess;
    mediaLocalRoots?: readonly string[];
    mediaReadFile?: OutboundMediaReadFile;
}): OutboundMediaAccess | undefined;
export declare function buildOutboundMediaLoadOptions(params?: OutboundMediaLoadParams): OutboundMediaLoadOptions;
