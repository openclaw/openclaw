import type { PluginCatalogItem } from "../../lib/plugins/index.ts";

export const WEIXIN_CHANNEL_ICON = new URL("../../assets/channels/weixin.svg", import.meta.url)
  .href;

export function resolveChannelIconOwner(
  plugins: readonly PluginCatalogItem[],
  channelId: string,
): PluginCatalogItem | undefined {
  return (
    plugins.find((plugin) => plugin.hasIcon && plugin.id === channelId) ??
    plugins.find((plugin) => plugin.hasIcon && plugin.channelIds?.includes(channelId))
  );
}
