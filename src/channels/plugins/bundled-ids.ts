import { listChannelCatalogEntries } from "../../plugins/channel-catalog-registry.js";
import type { PluginDiscoveryResult } from "../../plugins/discovery.js";
import { resolveBundledChannelRootScope } from "./bundled-root.js";

/**
 * Lists bundled plugin package ids from the catalog for a root-compatible
 * caller. The package root argument is retained for older call sites; discovery
 * state now owns the actual catalog root.
 */
export function listBundledChannelPluginIdsForRoot(
  _packageRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  discovery?: PluginDiscoveryResult,
): string[] {
  return listChannelCatalogEntries({
    origin: "bundled",
    env,
    discovery,
  })
    .map((entry) => entry.pluginId)
    .toSorted((left, right) => left.localeCompare(right));
}

/**
 * Lists bundled channel ids from catalog metadata for a root-compatible caller.
 * This can differ from plugin ids when one plugin manifest exposes aliases.
 */
export function listBundledChannelIdsForRoot(
  _packageRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  discovery?: PluginDiscoveryResult,
): string[] {
  return listChannelCatalogEntries({
    origin: "bundled",
    env,
    discovery,
  })
    .map((entry) => entry.channel.id)
    .filter((channelId): channelId is string => Boolean(channelId))
    .toSorted((left, right) => left.localeCompare(right));
}

/** Lists bundled plugin package ids for the active bundled root scope. */
export function listBundledChannelPluginIds(
  env: NodeJS.ProcessEnv = process.env,
  discovery?: PluginDiscoveryResult,
): string[] {
  return listBundledChannelPluginIdsForRoot(
    resolveBundledChannelRootScope(env).cacheKey,
    env,
    discovery,
  );
}

/** Lists bundled channel ids for the active bundled root scope. */
export function listBundledChannelIds(
  env: NodeJS.ProcessEnv = process.env,
  discovery?: PluginDiscoveryResult,
): string[] {
  return listBundledChannelIdsForRoot(resolveBundledChannelRootScope(env).cacheKey, env, discovery);
}
