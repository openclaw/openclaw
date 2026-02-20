import type { ChannelId } from "../../channels/plugins/types.js";

export type ChannelMessageAdapter = {
  supportsEmbeds: boolean;
  buildCrossContextEmbeds?: (originLabel: string) => unknown[];
};

const DEFAULT_ADAPTER: ChannelMessageAdapter = {
  supportsEmbeds: false,
};

const DISCORD_ADAPTER: ChannelMessageAdapter = {
  supportsEmbeds: true,
  buildCrossContextEmbeds: (originLabel: string) => [
    {
      description: `From ${originLabel}`,
    },
  ],
};

export function getChannelMessageAdapter(channel: ChannelId): ChannelMessageAdapter {
  if (channel === "discord") {
    return DISCORD_ADAPTER;
  }
  return DEFAULT_ADAPTER;
}
