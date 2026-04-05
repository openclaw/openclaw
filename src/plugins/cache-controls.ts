export const DEFAULT_PLUGIN_DISCOVERY_CACHE_MS = 1000;
export const DEFAULT_PLUGIN_MANIFEST_CACHE_MS = 1000;

export function shouldUsePluginSnapshotCache(env: NodeJS.ProcessEnv): boolean {
  if (env.MULLUSI_DISABLE_PLUGIN_DISCOVERY_CACHE?.trim()) {
    return false;
  }
  if (env.MULLUSI_DISABLE_PLUGIN_MANIFEST_CACHE?.trim()) {
    return false;
  }
  const discoveryCacheMs = env.MULLUSI_PLUGIN_DISCOVERY_CACHE_MS?.trim();
  if (discoveryCacheMs === "0") {
    return false;
  }
  const manifestCacheMs = env.MULLUSI_PLUGIN_MANIFEST_CACHE_MS?.trim();
  if (manifestCacheMs === "0") {
    return false;
  }
  return true;
}

export function resolvePluginCacheMs(rawValue: string | undefined, defaultMs: number): number {
  const raw = rawValue?.trim();
  if (raw === "" || raw === "0") {
    return 0;
  }
  if (!raw) {
    return defaultMs;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return defaultMs;
  }
  return Math.max(0, parsed);
}

export function resolvePluginSnapshotCacheTtlMs(env: NodeJS.ProcessEnv): number {
  const discoveryCacheMs = resolvePluginCacheMs(
    env.MULLUSI_PLUGIN_DISCOVERY_CACHE_MS,
    DEFAULT_PLUGIN_DISCOVERY_CACHE_MS,
  );
  const manifestCacheMs = resolvePluginCacheMs(
    env.MULLUSI_PLUGIN_MANIFEST_CACHE_MS,
    DEFAULT_PLUGIN_MANIFEST_CACHE_MS,
  );
  return Math.min(discoveryCacheMs, manifestCacheMs);
}

export function buildPluginSnapshotCacheEnvKey(env: NodeJS.ProcessEnv) {
  return {
    MULLUSI_BUNDLED_PLUGINS_DIR: env.MULLUSI_BUNDLED_PLUGINS_DIR ?? "",
    MULLUSI_DISABLE_PLUGIN_DISCOVERY_CACHE: env.MULLUSI_DISABLE_PLUGIN_DISCOVERY_CACHE ?? "",
    MULLUSI_DISABLE_PLUGIN_MANIFEST_CACHE: env.MULLUSI_DISABLE_PLUGIN_MANIFEST_CACHE ?? "",
    MULLUSI_PLUGIN_DISCOVERY_CACHE_MS: env.MULLUSI_PLUGIN_DISCOVERY_CACHE_MS ?? "",
    MULLUSI_PLUGIN_MANIFEST_CACHE_MS: env.MULLUSI_PLUGIN_MANIFEST_CACHE_MS ?? "",
    MULLUSI_HOME: env.MULLUSI_HOME ?? "",
    MULLUSI_STATE_DIR: env.MULLUSI_STATE_DIR ?? "",
    MULLUSI_CONFIG_PATH: env.MULLUSI_CONFIG_PATH ?? "",
    HOME: env.HOME ?? "",
    USERPROFILE: env.USERPROFILE ?? "",
    VITEST: env.VITEST ?? "",
  };
}
