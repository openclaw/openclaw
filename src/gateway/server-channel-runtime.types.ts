import type { ChannelId, ChannelAccountSnapshot } from "../channels/plugins/types.public.js";

/** Current runtime status for channels, split by default account and named account. */
export type ChannelRuntimeSnapshot = {
  channels: Partial<Record<ChannelId, ChannelAccountSnapshot>>;
  channelAccounts: Partial<Record<ChannelId, Record<string, ChannelAccountSnapshot>>>;
};
