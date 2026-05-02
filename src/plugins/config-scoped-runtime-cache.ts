import type { OpenClawConfig } from "../config/types.openclaw.js";

export type ConfigScopedRuntimeCache<T> = WeakMap<OpenClawConfig, Map<string, T>>;

export function resolveConfigScopedRuntimeCacheValue<T>(params: {
  cache: ConfigScopedRuntimeCache<T>;
  config?: OpenClawConfig;
  key: string;
  load: () => T;
}): T {
  if (!params.config) {
    return params.load();
  }
  let configCache = params.cache.get(params.config);
  if (!configCache) {
    configCache = new Map();
    params.cache.set(params.config, configCache);
  }
  const cached = configCache.get(params.key);
  if (cached !== undefined) {
    return cached;
  }
  const loaded = params.load();
  configCache.set(params.key, loaded);
  return loaded;
}
