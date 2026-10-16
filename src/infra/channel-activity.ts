// Tracks last inbound/outbound activity for channel accounts.
import type { ChannelId } from "../channels/plugins/channel-id.types.js";

/** Direction of the last observed activity for a channel/account pair. */
export type ChannelDirection = "inbound" | "outbound";

type ActivityEntry = {
  inboundAt: number | null;
  outboundAt: number | null;
};

const activity = new Map<string, ActivityEntry>();

function keyFor(params: { channel: ChannelId; accountId?: string | null }): string {
  const accountId = params.accountId?.trim() || "default";
  return `${params.channel}:${accountId}`;
}

/** Records the latest inbound or outbound activity timestamp for a channel/account. */
export function recordChannelActivity(params: {
  channel: ChannelId;
  accountId?: string | null;
  direction: ChannelDirection;
  at?: number;
}) {
  const at = typeof params.at === "number" ? params.at : Date.now();
  const key = keyFor(params);
  const entry = activity.get(key) ?? { inboundAt: null, outboundAt: null };
  activity.set(key, entry);
  if (params.direction === "inbound") {
    entry.inboundAt = at;
  }
  if (params.direction === "outbound") {
    entry.outboundAt = at;
  }
}

/** Returns the latest known inbound/outbound activity timestamps for a channel/account. */
export function getChannelActivity(params: {
  channel: ChannelId;
  accountId?: string | null;
}): ActivityEntry {
  return (
    activity.get(keyFor(params)) ?? {
      inboundAt: null,
      outboundAt: null,
    }
  );
}
