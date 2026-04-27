import { createJiti } from "jiti";
import { buildPluginLoaderJitiOptions, createPluginLoaderJitiCacheKey, resolvePluginLoaderJitiConfig, } from "./sdk-alias.js";
export function getCachedPluginJitiLoader(params) {
    const jitiFilename = params.jitiFilename ?? params.modulePath;
    if (params.cacheScopeKey) {
        const scopedCacheKey = `${jitiFilename}::${params.cacheScopeKey}`;
        const cached = params.cache.get(scopedCacheKey);
        if (cached) {
            return cached;
        }
    }
    const hasAliasOverride = Boolean(params.aliasMap);
    const hasTryNativeOverride = typeof params.tryNative === "boolean";
    const defaultConfig = hasAliasOverride || hasTryNativeOverride
        ? resolvePluginLoaderJitiConfig({
            modulePath: params.modulePath,
            argv1: params.argvEntry ?? process.argv[1],
            moduleUrl: params.importerUrl,
            ...(params.preferBuiltDist ? { preferBuiltDist: true } : {}),
            ...(params.pluginSdkResolution
                ? { pluginSdkResolution: params.pluginSdkResolution }
                : {}),
        })
        : null;
    const canReuseDefaultCacheKey = defaultConfig !== null &&
        (!hasAliasOverride || params.aliasMap === defaultConfig.aliasMap) &&
        (!hasTryNativeOverride || params.tryNative === defaultConfig.tryNative);
    const resolved = defaultConfig
        ? {
            tryNative: params.tryNative ?? defaultConfig.tryNative,
            aliasMap: params.aliasMap ?? defaultConfig.aliasMap,
            cacheKey: canReuseDefaultCacheKey ? defaultConfig.cacheKey : undefined,
        }
        : resolvePluginLoaderJitiConfig({
            modulePath: params.modulePath,
            argv1: params.argvEntry ?? process.argv[1],
            moduleUrl: params.importerUrl,
            ...(params.preferBuiltDist ? { preferBuiltDist: true } : {}),
            ...(params.pluginSdkResolution ? { pluginSdkResolution: params.pluginSdkResolution } : {}),
        });
    const { tryNative, aliasMap } = resolved;
    const cacheKey = resolved.cacheKey ??
        createPluginLoaderJitiCacheKey({
            tryNative,
            aliasMap,
        });
    const scopedCacheKey = `${jitiFilename}::${params.cacheScopeKey ?? cacheKey}`;
    const cached = params.cache.get(scopedCacheKey);
    if (cached) {
        return cached;
    }
    const loader = (params.createLoader ?? createJiti)(jitiFilename, {
        ...buildPluginLoaderJitiOptions(aliasMap),
        tryNative,
    });
    params.cache.set(scopedCacheKey, loader);
    return loader;
}
