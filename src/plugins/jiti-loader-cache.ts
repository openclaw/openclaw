import { createJiti } from "jiti";
import {
  buildPluginLoaderAliasMap,
  buildPluginLoaderJitiOptions,
  shouldPreferNativeJiti,
} from "./sdk-alias.js";

export type PluginJitiLoaderCache = Map<string, ReturnType<typeof createJiti>>;

export function getCachedPluginJitiLoader(params: {
  cache: PluginJitiLoaderCache;
  modulePath: string;
  importerUrl: string;
  argvEntry?: string;
}): ReturnType<typeof createJiti> {
  const aliasMap = buildPluginLoaderAliasMap(
    params.modulePath,
    params.argvEntry ?? process.argv[1],
    params.importerUrl,
  );
  const tryNative = shouldPreferNativeJiti(params.modulePath);
  const cacheKey = JSON.stringify({
    tryNative,
    aliasMap: Object.entries(aliasMap).toSorted(([left], [right]) => left.localeCompare(right)),
  });
  const cached = params.cache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const loader = createJiti(params.modulePath, {
    ...buildPluginLoaderJitiOptions(aliasMap),
    tryNative,
  });
  params.cache.set(cacheKey, loader);
  return loader;
}
