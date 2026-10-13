/** Stable public facade for plugin loading and runtime-registry resolution. */
import { loadOpenClawPlugins, loadOpenClawPluginsAsync } from "./loader-runtime-load.js";
import type { PluginLoadOptions } from "./loader-types.js";
export { resolveCompatibleRuntimePluginRegistry } from "./active-runtime-registry.js";
export {
  clearPluginRegistryLoadCache,
  isPluginRegistryLoadInFlight,
  resolvePluginRegistryLoadCacheKey,
} from "./loader-cache.js";
export {
  acquirePluginRegistryForInspection,
  loadAndActivateRootPluginRegistry,
  loadOpenClawPluginsAsync,
} from "./loader-runtime-load.js";

/** Loads a caller-owned registry value without changing the process-wide active registry. */
export function loadPluginRegistryHandle(options: PluginLoadOptions = {}) {
  return loadOpenClawPlugins({ ...options, activate: false });
}

/** Prepares metadata through the worker before loading a caller-owned registry. */
export function loadPluginRegistryHandleAsync(options: PluginLoadOptions = {}) {
  return loadOpenClawPluginsAsync({ ...options, activate: false });
}

/** Collects CLI descriptors through the same validation and instance owner as runtime loading. */
export async function loadOpenClawPluginCliRegistry(options: PluginLoadOptions = {}) {
  return loadOpenClawPluginsAsync({
    ...options,
    mode: "cli-metadata",
    activate: false,
  });
}

export { loadOpenClawPlugins };
export type { PluginLoadOptions };
