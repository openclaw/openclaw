import type { PluginManifestRecord } from "./manifest-registry.types.js";
import { getPluginCache, retirePluginCacheInstance } from "./plugin-cache.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { PluginInstance } from "./plugin-instance.js";

/** Setup callbacks belong to the inventory that loaded them. */
export function getPluginSetupModuleLoader(
  record: PluginManifestRecord,
  source: string,
  rootDir: string,
  options: { stateOperations?: false } = {},
) {
  const cache = getPluginCache();
  const key = `setup:${record.id}:${source}${options.stateOperations === false ? ":no-state-operations" : ""}`;
  const cached = cache.setupModules.get(key);
  if (!cached && cache.retirement) {
    throw new Error(`Plugin ${record.id} setup inventory has retired`);
  }
  const instance = cached ?? new PluginInstance(record.id, { cache });
  const discard = () => {
    // Repeated inspections share callbacks already published by successful initialization.
    if (instance.controlPlaneInitialized) {
      return;
    }
    // A retained failed loader cannot evict its replacement; the cache joins cleanup failures.
    if (cache.setupModules.get(key) === instance) {
      cache.setupModules.delete(key);
    }
    void retirePluginCacheInstance(instance, cache).catch(() => {});
  };
  const discardOnFailure = <T>(run: () => T): T => {
    try {
      return run();
    } catch (error) {
      discard();
      throw error;
    }
  };
  if (!cached) {
    cache.setupModules.set(key, instance);
    discardOnFailure(() => {
      bindPluginInstanceModuleLoader({
        instance,
        origin: record.origin,
        source,
        rootDir,
        stateOperations: options.stateOperations,
      });
    });
  }
  return Object.assign((entry: string) => discardOnFailure(() => instance.loadModule(entry)), {
    initialize<T>(this: void, run: () => T): T {
      return discardOnFailure(() => {
        const result = run();
        instance.controlPlaneInitialized = true;
        return result;
      });
    },
  });
}
