export { parseClawHubPluginSpec } from "./clawhub-spec.js";
export type ClawHubPackageFamily = "skill" | "code-plugin" | "bundle-plugin";
export type ClawHubPackageChannel = "official" | "community" | "private";
export type ClawHubPackageCompatibility = {
    pluginApiRange?: string;
    builtWithOpenClawVersion?: string;
    pluginSdkVersion?: string;
    minGatewayVersion?: string;
};
export type ClawHubPackageListItem = {
    name: string;
    displayName: string;
    family: ClawHubPackageFamily;
    runtimeId?: string | null;
    channel: ClawHubPackageChannel;
    isOfficial: boolean;
    summary?: string | null;
    ownerHandle?: string | null;
    createdAt: number;
    updatedAt: number;
    latestVersion?: string | null;
    capabilityTags?: string[];
    executesCode?: boolean;
    verificationTier?: string | null;
};
export type ClawHubPackageDetail = {
    package: (ClawHubPackageListItem & {
        tags?: Record<string, string>;
        compatibility?: ClawHubPackageCompatibility | null;
        capabilities?: {
            executesCode?: boolean;
            runtimeId?: string;
            capabilityTags?: string[];
            bundleFormat?: string;
            hostTargets?: string[];
            pluginKind?: string;
            channels?: string[];
            providers?: string[];
            hooks?: string[];
            bundledSkills?: string[];
        } | null;
        verification?: {
            tier?: string;
            scope?: string;
            summary?: string;
            sourceRepo?: string;
            sourceCommit?: string;
            hasProvenance?: boolean;
            scanStatus?: string;
        } | null;
    }) | null;
    owner?: {
        handle?: string | null;
        displayName?: string | null;
        image?: string | null;
    } | null;
};
export type ClawHubPackageVersion = {
    package: {
        name: string;
        displayName: string;
        family: ClawHubPackageFamily;
    } | null;
    version: {
        version: string;
        createdAt: number;
        changelog: string;
        distTags?: string[];
        files?: Array<{
            path: string;
            size: number;
            sha256: string;
            contentType?: string;
        }>;
        sha256hash?: string | null;
        compatibility?: ClawHubPackageCompatibility | null;
        capabilities?: ClawHubPackageDetail["package"] extends infer T ? T extends {
            capabilities?: infer C;
        } ? C : never : never;
        verification?: ClawHubPackageDetail["package"] extends infer T ? T extends {
            verification?: infer C;
        } ? C : never : never;
    } | null;
};
export type ClawHubPackageSearchResult = {
    score: number;
    package: ClawHubPackageListItem;
};
export type ClawHubSkillSearchResult = {
    score: number;
    slug: string;
    displayName: string;
    summary?: string;
    version?: string;
    updatedAt?: number;
};
export type ClawHubSkillDetail = {
    skill: {
        slug: string;
        displayName: string;
        summary?: string;
        tags?: Record<string, string>;
        createdAt: number;
        updatedAt: number;
    } | null;
    latestVersion?: {
        version: string;
        createdAt: number;
        changelog?: string;
    } | null;
    metadata?: {
        os?: string[] | null;
        systems?: string[] | null;
    } | null;
    owner?: {
        handle?: string | null;
        displayName?: string | null;
        image?: string | null;
    } | null;
};
export type ClawHubSkillListResponse = {
    items: Array<{
        slug: string;
        displayName: string;
        summary?: string;
        tags?: Record<string, string>;
        latestVersion?: {
            version: string;
            createdAt: number;
            changelog?: string;
        } | null;
        metadata?: {
            os?: string[] | null;
            systems?: string[] | null;
        } | null;
        createdAt: number;
        updatedAt: number;
    }>;
    nextCursor?: string | null;
};
export type ClawHubDownloadResult = {
    archivePath: string;
    integrity: string;
    cleanup: () => Promise<void>;
};
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export declare class ClawHubRequestError extends Error {
    readonly status: number;
    readonly requestPath: string;
    readonly responseBody: string;
    constructor(params: {
        path: string;
        status: number;
        body: string;
    });
}
export declare function resolveClawHubAuthToken(): Promise<string | undefined>;
export declare function resolveClawHubBaseUrl(baseUrl?: string): string;
export declare function formatSha256Integrity(bytes: Uint8Array): string;
export declare function normalizeClawHubSha256Integrity(value: string): string | null;
export declare function normalizeClawHubSha256Hex(value: string): string | null;
export declare function fetchClawHubPackageDetail(params: {
    name: string;
    baseUrl?: string;
    token?: string;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
}): Promise<ClawHubPackageDetail>;
export declare function fetchClawHubPackageVersion(params: {
    name: string;
    version: string;
    baseUrl?: string;
    token?: string;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
}): Promise<ClawHubPackageVersion>;
export declare function searchClawHubPackages(params: {
    query: string;
    family?: ClawHubPackageFamily;
    baseUrl?: string;
    token?: string;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
    limit?: number;
}): Promise<ClawHubPackageSearchResult[]>;
export declare function searchClawHubSkills(params: {
    query: string;
    baseUrl?: string;
    token?: string;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
    limit?: number;
}): Promise<ClawHubSkillSearchResult[]>;
export declare function fetchClawHubSkillDetail(params: {
    slug: string;
    baseUrl?: string;
    token?: string;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
}): Promise<ClawHubSkillDetail>;
export declare function listClawHubSkills(params: {
    baseUrl?: string;
    token?: string;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
    limit?: number;
}): Promise<ClawHubSkillListResponse>;
export declare function downloadClawHubPackageArchive(params: {
    name: string;
    version?: string;
    tag?: string;
    baseUrl?: string;
    token?: string;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
}): Promise<ClawHubDownloadResult>;
export declare function downloadClawHubSkillArchive(params: {
    slug: string;
    version?: string;
    tag?: string;
    baseUrl?: string;
    token?: string;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
}): Promise<ClawHubDownloadResult>;
export declare function resolveLatestVersionFromPackage(detail: ClawHubPackageDetail): string | null;
export declare function isClawHubFamilySkill(detail: ClawHubPackageDetail | ClawHubSkillDetail): boolean;
export declare function satisfiesPluginApiRange(pluginApiVersion: string, pluginApiRange?: string | null): boolean;
export declare function satisfiesGatewayMinimum(currentVersion: string, minGatewayVersion?: string | null): boolean;
