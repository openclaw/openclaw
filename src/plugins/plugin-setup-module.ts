import path from "node:path";
import type { PluginManifestRecord } from "./manifest-registry.types.js";
import { clearPluginModuleRequireCache, isJavaScriptModulePath } from "./native-module-require.js";
import { getPluginCache, getPluginCacheSource, retirePluginCacheInstance } from "./plugin-cache.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { PluginInstance } from "./plugin-instance.js";

/** Setup callbacks belong to the inventory that loaded them. */
export function getPluginSetupModuleLoader(
  record: PluginManifestRecord,
  source: string,
  rootDir: string,
) {
  const cache = getPluginCache();
  const key = `setup:${record.id}:${source}`;
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
  if (!cached) {
    cache.setupModules.set(key, instance);
    try {
      if (record.origin === "bundled" && isJavaScriptModulePath(source)) {
        const distribution = path.dirname(path.dirname(rootDir));
        const dependencyRoot =
          path.basename(path.dirname(rootDir)) === "extensions" &&
          path.basename(distribution) === "dist"
            ? distribution
            : rootDir;
        // Cold metadata reset refreshes CJS entry and hoisted helpers. Ordinary
        // inventory retirement must not evict code still used by another instance.
        getPluginCacheSource(source).disposeModule ??= () =>
          clearPluginModuleRequireCache(source, dependencyRoot);
      }
      bindPluginInstanceModuleLoader({
        instance,
        origin: record.origin,
        source,
        rootDir,
      });
    } catch (error) {
      discard();
      throw error;
    }
  }
  return Object.assign(
    (entry: string) => {
      try {
        return instance.loadModule(entry);
      } catch (error) {
        discard();
        throw error;
      }
    },
    {
      initialize<T>(this: void, run: () => T): T {
        try {
          const result = run();
          instance.controlPlaneInitialized = true;
          return result;
        } catch (error) {
          discard();
          throw error;
        }
      },
    },
  );
}
