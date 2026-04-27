export declare const DEFAULT_PLUGIN_DISCOVERY_CACHE_MS = 1000;
export declare const DEFAULT_PLUGIN_MANIFEST_CACHE_MS = 1000;
export declare function shouldUsePluginSnapshotCache(env: NodeJS.ProcessEnv): boolean;
export declare function resolvePluginCacheMs(rawValue: string | undefined, defaultMs: number): number;
export declare function resolvePluginSnapshotCacheTtlMs(env: NodeJS.ProcessEnv): number;
export declare function buildPluginSnapshotCacheEnvKey(env: NodeJS.ProcessEnv): string;
