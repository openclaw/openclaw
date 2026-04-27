import type { PluginWebFetchProviderEntry, PluginWebSearchProviderEntry } from "./types.js";
export declare function loadBundledWebSearchProviderEntriesFromDir(params: {
    dirName: string;
    pluginId: string;
}): PluginWebSearchProviderEntry[] | null;
export declare function loadBundledRuntimeWebSearchProviderEntriesFromDir(params: {
    dirName: string;
    pluginId: string;
}): PluginWebSearchProviderEntry[] | null;
export declare function loadBundledWebFetchProviderEntriesFromDir(params: {
    dirName: string;
    pluginId: string;
}): PluginWebFetchProviderEntry[] | null;
export declare function resolveBundledExplicitWebSearchProvidersFromPublicArtifacts(params: {
    onlyPluginIds: readonly string[];
}): PluginWebSearchProviderEntry[] | null;
export declare function resolveBundledExplicitRuntimeWebSearchProvidersFromPublicArtifacts(params: {
    onlyPluginIds: readonly string[];
}): PluginWebSearchProviderEntry[] | null;
export declare function resolveBundledExplicitWebFetchProvidersFromPublicArtifacts(params: {
    onlyPluginIds: readonly string[];
}): PluginWebFetchProviderEntry[] | null;
export declare function hasBundledWebSearchProviderPublicArtifact(pluginId: string): boolean;
export declare function hasBundledWebFetchProviderPublicArtifact(pluginId: string): boolean;
