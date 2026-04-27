export type PluginManifestRegistryCacheEntry = {
    expiresAt: number;
    registry: unknown;
};
export declare const pluginManifestRegistryCache: Map<string, PluginManifestRegistryCacheEntry>;
export declare function clearPluginManifestRegistryCache(): void;
