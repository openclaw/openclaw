/** Caches plugin module loaders and native-load stats for runtime/source module imports. */
/** Caches plugin module loaders and native-load stats for runtime/source module imports. */
import path from "node:path";
import { toSafeImportPath } from "../shared/import-specifier.js";
import { tryNativeRequireJavaScriptModule } from "./native-module-require.js";
import { PluginLruCache } from "./plugin-cache-primitives.js";
import { installOpenClawInternalCorePackageNativeResolver } from "./plugin-sdk-native-resolver.js";
import {
  resolvePluginLoaderModuleConfig,
  type PluginSdkResolutionPreference,
} from "./sdk-alias.js";

/** Native module loader used for plugin source/runtime imports. */
export type PluginModuleLoader = (target: string, ...rest: unknown[]) => unknown;
export type PluginModuleLoaderCache = Pick<
  PluginLruCache<PluginModuleLoader>,
  "clear" | "get" | "set" | "size"
>;
export type ResolvePluginModuleLoaderCacheEntryParams = {
  modulePath: string;
  importerUrl: string;
  argvEntry?: string;
  preferBuiltDist?: boolean;
  loaderFilename?: string;
  aliasMap?: Record<string, string>;
  devSourceRoot?: string | null;
  pluginSdkResolution?: PluginSdkResolutionPreference;
  cacheScopeKey?: string;
  sharedCacheScopeKey?: string;
};
export type PluginModuleLoaderCacheEntry = {
  loaderFilename: string;
  aliasMap: Record<string, string>;
  cacheKey: string;
  scopedCacheKey: string;
};
export type PluginModuleLoaderStatsSnapshot = {
  calls: number;
  nativeHits: number;
  nativeMisses: number;
};

const DEFAULT_PLUGIN_MODULE_LOADER_CACHE_ENTRIES = 128;
const pluginModuleLoaderStats = {
  calls: 0,
  nativeHits: 0,
  nativeMisses: 0,
};

/** Returns process-local plugin module loader stats for diagnostics and tests. */
export function getPluginModuleLoaderStats(): PluginModuleLoaderStatsSnapshot {
  return {
    calls: pluginModuleLoaderStats.calls,
    nativeHits: pluginModuleLoaderStats.nativeHits,
    nativeMisses: pluginModuleLoaderStats.nativeMisses,
  };
}

export function createPluginModuleLoaderCache(
  maxEntries = DEFAULT_PLUGIN_MODULE_LOADER_CACHE_ENTRIES,
): PluginModuleLoaderCache {
  return new PluginLruCache<PluginModuleLoader>(maxEntries);
}

function resolveDefaultPluginModuleLoaderConfig(
  params: ResolvePluginModuleLoaderCacheEntryParams,
): ReturnType<typeof resolvePluginLoaderModuleConfig> {
  return resolvePluginLoaderModuleConfig({
    modulePath: params.modulePath,
    argv1: params.argvEntry ?? process.argv[1],
    moduleUrl: params.importerUrl,
    devSourceRoot: params.devSourceRoot,
    ...(params.preferBuiltDist ? { preferBuiltDist: true } : {}),
    ...(params.pluginSdkResolution ? { pluginSdkResolution: params.pluginSdkResolution } : {}),
  });
}

export function resolvePluginModuleLoaderCacheEntry(
  params: ResolvePluginModuleLoaderCacheEntryParams,
): PluginModuleLoaderCacheEntry {
  const loaderFilename = toSafeImportPath(params.loaderFilename ?? params.modulePath);
  const config = resolveDefaultPluginModuleLoaderConfig(params);
  const cacheKey = `${loaderFilename}::native::${JSON.stringify(config.aliasMap)}`;
  const scopedCacheKey = `${loaderFilename}::${
    params.sharedCacheScopeKey ??
    (params.cacheScopeKey ? `${params.cacheScopeKey}::${cacheKey}` : cacheKey)
  }`;
  return {
    loaderFilename,
    aliasMap: config.aliasMap,
    cacheKey,
    scopedCacheKey,
  };
}

function createPluginModuleLoader(params: {
  loaderFilename: string;
  aliasMap: Record<string, string>;
}): PluginModuleLoader {
  const loadedTargetExports = new Map<string, unknown>();
  const loadCachedTarget = (target: string, rest: unknown[], load: () => unknown): unknown => {
    if (rest.length > 0) {
      return load();
    }
    if (loadedTargetExports.has(target)) {
      return loadedTargetExports.get(target);
    }
    const loaded = load();
    loadedTargetExports.set(target, loaded);
    return loaded;
  };
  return ((target: string, ...rest: unknown[]) => {
    return loadCachedTarget(target, rest, () => {
      pluginModuleLoaderStats.calls += 1;
      const native = tryNativeRequireJavaScriptModule(target, {
        allowWindows: true,
        aliasMap: params.aliasMap,
        fallbackOnMissingDependency: false,
        fallbackOnNativeError: false,
      });
      if (native.ok) {
        pluginModuleLoaderStats.nativeHits += 1;
        return native.moduleExport;
      }
      pluginModuleLoaderStats.nativeMisses += 1;
      throw new Error(
        `Plugin module not found: ${target}. All plugin modules must be pre-compiled to JavaScript. Use native require() path only.`,
      );
    });
  }) as PluginModuleLoader;
}

export function getCachedPluginModuleLoader(
  params: ResolvePluginModuleLoaderCacheEntryParams & {
    cache: PluginModuleLoaderCache;
  },
): PluginModuleLoader {
  installOpenClawInternalCorePackageNativeResolver({ moduleUrl: params.importerUrl });
  const cacheEntry = resolvePluginModuleLoaderCacheEntry(params);
  const cached = params.cache.get(cacheEntry.scopedCacheKey);
  if (cached) {
    return cached;
  }
  const loader = createPluginModuleLoader({
    loaderFilename: cacheEntry.loaderFilename,
    aliasMap: cacheEntry.aliasMap,
  });
  params.cache.set(cacheEntry.scopedCacheKey, loader);
  return loader;
}
