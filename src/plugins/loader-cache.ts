import { resolvePluginLoadCacheContext } from "./loader-load-context.js";
import type { PluginLoadOptions } from "./loader-types.js";
import { clearPluginRuntimeArtifactResolutionMemo } from "./plugin-runtime-artifact-resolution.js";
import { getPluginLoaderCacheState } from "./registry-lifecycle.js";

/** Registry reuse is off for explicit opt-outs and for raw env-substituted config loads. */
function isPluginRegistryCacheEnabled(options: PluginLoadOptions): boolean {
  return options.cache !== false && options.resolveRawConfigEnvVars !== true;
}

/** Loads whose finished registry the cache hands to the next caller with the same key. */
export function isCachedPluginRegistryLoad(options: PluginLoadOptions): boolean {
  return (
    !options.previousRegistry &&
    !options.borrowRegistry &&
    !options.moduleRecoveries &&
    isPluginRegistryCacheEnabled(options)
  );
}

export function clearPluginRegistryLoadCache(): void {
  clearPluginRuntimeArtifactResolutionMemo();
  getPluginLoaderCacheState().clearCachedRegistries();
}

export function resolvePluginRegistryLoadCacheKey(options: PluginLoadOptions = {}): string {
  return resolvePluginLoadCacheContext(options).cacheKey;
}

export function isPluginRegistryLoadInFlight(options: PluginLoadOptions = {}): boolean {
  const context = resolvePluginLoadCacheContext(options);
  return context.cacheState.isLoadInFlight(context.cacheKey);
}
