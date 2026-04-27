import type { PluginLoadOptions } from "./loader.js";
import { type PluginManifestRecord } from "./manifest-registry.js";
import type { PluginWebFetchProviderEntry } from "./types.js";
declare function resetWebFetchProviderSnapshotCacheForTests(): void;
export declare const __testing: {
    readonly resetWebFetchProviderSnapshotCacheForTests: typeof resetWebFetchProviderSnapshotCacheForTests;
};
export declare function resolvePluginWebFetchProviders(params: {
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
    bundledAllowlistCompat?: boolean;
    onlyPluginIds?: readonly string[];
    activate?: boolean;
    cache?: boolean;
    mode?: "runtime" | "setup";
    origin?: PluginManifestRecord["origin"];
}): PluginWebFetchProviderEntry[];
export declare function resolveRuntimeWebFetchProviders(params: {
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
    bundledAllowlistCompat?: boolean;
    onlyPluginIds?: readonly string[];
    origin?: PluginManifestRecord["origin"];
}): PluginWebFetchProviderEntry[];
export {};
