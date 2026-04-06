import { listChannelCatalogEntries } from "../../plugins/channel-catalog-registry.js";

export const BUNDLED_CHANNEL_PLUGIN_IDS = listChannelCatalogEntries({ origin: "bundled" })
  .map((entry) => entry.pluginId)
  .toSorted((left, right) => left.localeCompare(right));

export function listBundledChannelPluginIds(): string[] {
  return [...BUNDLED_CHANNEL_PLUGIN_IDS];
}
