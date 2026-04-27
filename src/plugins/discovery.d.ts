import type { PluginBundleFormat, PluginDiagnostic, PluginFormat } from "./manifest-types.js";
import { type PluginManifest, type OpenClawPackageManifest } from "./manifest.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
export type PluginCandidate = {
    idHint: string;
    source: string;
    setupSource?: string;
    rootDir: string;
    origin: PluginOrigin;
    format?: PluginFormat;
    bundleFormat?: PluginBundleFormat;
    workspaceDir?: string;
    packageName?: string;
    packageVersion?: string;
    packageDescription?: string;
    packageDir?: string;
    packageManifest?: OpenClawPackageManifest;
    bundledManifest?: PluginManifest;
    bundledManifestPath?: string;
};
export type PluginDiscoveryResult = {
    candidates: PluginCandidate[];
    diagnostics: PluginDiagnostic[];
};
export declare function clearPluginDiscoveryCache(): void;
export type CandidateBlockReason = "source_escapes_root" | "path_stat_failed" | "path_world_writable" | "path_suspicious_ownership";
export declare function discoverOpenClawPlugins(params: {
    workspaceDir?: string;
    extraPaths?: string[];
    ownershipUid?: number | null;
    cache?: boolean;
    env?: NodeJS.ProcessEnv;
}): PluginDiscoveryResult;
