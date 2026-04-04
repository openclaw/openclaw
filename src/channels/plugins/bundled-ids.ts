import { listBundledPluginMetadata } from "../../plugins/bundled-plugin-metadata.js";

export const BUNDLED_CHANNEL_PLUGIN_IDS = listBundledPluginMetadata({
  includeChannelConfigs: false,
  includeSyntheticChannelConfigs: false,
})
  .filter(({ manifest }) => Array.isArray(manifest.channels) && manifest.channels.length > 0)
  .map(({ manifest }) => manifest.id)
  .toSorted((left, right) => left.localeCompare(right));

export function listBundledChannelPluginIds(): string[] {
  return [...BUNDLED_CHANNEL_PLUGIN_IDS];
}
