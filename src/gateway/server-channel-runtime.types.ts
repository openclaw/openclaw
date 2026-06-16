// Gateway channel runtime snapshot types.
// Exposes read-only channel/account state to status and server-method surfaces.
import type { ChannelId } from "../channels/plugins/channel-id.types.js";
import type { ChannelAccountSnapshot } from "../channels/plugins/types.core.js";

/** Snapshot of channel runtime state keyed by channel and account id. */
export type ChannelRuntimeSnapshot = {
  channels: Partial<Record<ChannelId, ChannelAccountSnapshot>>;
  channelAccounts: Partial<Record<ChannelId, Record<string, ChannelAccountSnapshot>>>;
};
