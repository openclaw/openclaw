import { resolvePluginLoadCacheContext } from "./loader-load-context.js";
import type { PluginLoadOptions } from "./loader-types.js";
import { clearPluginRuntimeArtifactResolutionMemo } from "./plugin-runtime-artifact-resolution.js";
import { getPluginLoaderCacheState } from "./registry-lifecycle.js";
import type { PluginRegistry } from "./registry-types.js";

/** Registry reuse is off for explicit opt-outs and for raw env-substituted config loads. */
export function isPluginRegistryCacheEnabled(options: PluginLoadOptions): boolean {
  return options.cache !== false && options.resolveRawConfigEnvVars !== true;
}

/** Reuses the loader's exact entry without registering or activating plugins. */
export function getCachedPluginRegistry(options: PluginLoadOptions): PluginRegistry | undefined {
  if (
    options.previousRegistry ||
    options.borrowRegistry ||
    options.moduleRecoveries ||
    !isPluginRegistryCacheEnabled(options)
  ) {
    return undefined;
  }
  const context = resolvePluginLoadCacheContext(options);
  return context.cacheState.get(context.cacheKey);
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
