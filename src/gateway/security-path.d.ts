export type SecurityPathCanonicalization = {
    canonicalPath: string;
    candidates: string[];
    decodePasses: number;
    decodePassLimitReached: boolean;
    malformedEncoding: boolean;
    rawNormalizedPath: string;
};
export declare function buildCanonicalPathCandidates(pathname: string, maxDecodePasses?: number): {
    candidates: string[];
    decodePasses: number;
    decodePassLimitReached: boolean;
    malformedEncoding: boolean;
};
export declare function canonicalizePathVariant(pathname: string): string;
export declare function canonicalizePathForSecurity(pathname: string): SecurityPathCanonicalization;
export declare function hasSecurityPathCanonicalizationAnomaly(pathname: string): boolean;
export declare function isPathProtectedByPrefixes(pathname: string, prefixes: readonly string[]): boolean;
export declare const PROTECTED_PLUGIN_ROUTE_PREFIXES: readonly ["/api/channels"];
export declare function isProtectedPluginRoutePath(pathname: string): boolean;
