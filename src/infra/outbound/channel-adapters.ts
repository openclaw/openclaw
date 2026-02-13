import type { ChannelId } from "../../channels/plugins/types.js";

export type ChannelMessageAdapter = {
  supportsEmbeds: boolean;
  buildCrossContextEmbeds?: (originLabel: string) => unknown[];
};

const DEFAULT_ADAPTER: ChannelMessageAdapter = {
  supportsEmbeds: false,
};

export function getChannelMessageAdapter(_channel: ChannelId): ChannelMessageAdapter {
  return DEFAULT_ADAPTER;
}
