import { listChannelCatalogEntries } from "../../plugins/channel-catalog-registry.js";
import { resolveBundledChannelRootScope } from "./bundled-root.js";

const bundledChannelPluginIdsByRoot = new Map<string, readonly string[]>();

export function listBundledChannelPluginIdsForRoot(
  packageRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const cached = bundledChannelPluginIdsByRoot.get(packageRoot);
  if (cached) {
    return [...cached];
  }
  const pluginIds = listChannelCatalogEntries({ origin: "bundled", env })
    .map((entry) => entry.pluginId)
    .toSorted((left, right) => left.localeCompare(right));
  bundledChannelPluginIdsByRoot.set(packageRoot, pluginIds);
  return [...pluginIds];
}

export function listBundledChannelPluginIds(env: NodeJS.ProcessEnv = process.env): string[] {
  return listBundledChannelPluginIdsForRoot(resolveBundledChannelRootScope(env).cacheKey, env);
}
