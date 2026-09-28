import { listChannelCatalogEntries } from "../../plugins/channel-catalog-registry.js";
import type { PluginDiscoveryResult } from "../../plugins/discovery.js";

/**
 * Lists bundled channel ids for the current runtime catalog.
 */
export function listBundledChannelIds(
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
