import { createJiti } from "jiti";
import { buildPluginLoaderJitiOptions, resolvePluginLoaderJitiConfig } from "./sdk-alias.js";

export type PluginJitiLoaderCache = Map<string, ReturnType<typeof createJiti>>;

export function getCachedPluginJitiLoader(params: {
  cache: PluginJitiLoaderCache;
  modulePath: string;
  importerUrl: string;
  argvEntry?: string;
  preferBuiltDist?: boolean;
  jitiFilename?: string;
}): ReturnType<typeof createJiti> {
  const { tryNative, aliasMap, cacheKey } = resolvePluginLoaderJitiConfig({
    modulePath: params.modulePath,
    argv1: params.argvEntry ?? process.argv[1],
    moduleUrl: params.importerUrl,
    ...(params.preferBuiltDist ? { preferBuiltDist: true } : {}),
  });
  const scopedCacheKey = `${params.jitiFilename ?? params.modulePath}::${cacheKey}`;
  const cached = params.cache.get(scopedCacheKey);
  if (cached) {
    return cached;
  }
  const loader = createJiti(params.jitiFilename ?? params.modulePath, {
    ...buildPluginLoaderJitiOptions(aliasMap),
    tryNative,
  });
  params.cache.set(scopedCacheKey, loader);
  return loader;
}
