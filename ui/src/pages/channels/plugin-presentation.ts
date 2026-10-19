import type { PluginCatalogItem } from "../../lib/plugins/index.ts";

export function resolveChannelIconOwner(
  plugins: readonly PluginCatalogItem[],
  channelId: string,
): PluginCatalogItem | undefined {
  return (
    plugins.find((plugin) => plugin.hasIcon && plugin.id === channelId) ??
    plugins.find((plugin) => plugin.hasIcon && plugin.channelIds?.includes(channelId))
  );
}
