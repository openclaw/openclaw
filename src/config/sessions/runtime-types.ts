// Runtime session types describe the store hooks shared across config, gateway, and channels.
import type { MsgContext } from "../../auto-reply/templating.js";
import type { ChannelRouteRef } from "../../plugin-sdk/channel-route.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { GroupKeyResolution, SessionEntry } from "./types.js";

export type RecordInboundSessionMetaParams = {
  /** Set false to only patch existing entries; missing sessions stay absent. */
  createIfMissing?: boolean;
  /** Inbound message context whose stable metadata is derived and persisted. */
  ctx: MsgContext;
  /** Group routing resolution for group-owned session keys. */
  groupResolution?: GroupKeyResolution | null;
  /** Canonical or alias session key for the inbound conversation. */
  sessionKey: string;
  /** Explicit store target for file-backed stores and SQLite migration adapters. */
  storePath: string;
};

export type UpdateSessionLastRouteParams = Omit<RecordInboundSessionMetaParams, "ctx"> & {
  /** Account owning the delivery route when the channel is multi-account. */
  accountId?: string;
  /** Delivery channel id persisted as the last route channel. */
  channel?: string;
  /** Optional inbound context whose session metadata is derived alongside the route. */
  ctx?: MsgContext;
  /** Explicit delivery context merged over the persisted session fallback. */
  deliveryContext?: DeliveryContext;
  /** Canonical channel route persisted as the session route slot. */
  route?: ChannelRouteRef;
  /** Thread/topic id for the delivery route, when the transport has one. */
  threadId?: string | number;
  /** Delivery target persisted as the last route recipient. */
  to?: string;
};

/** Runtime hook for reading a session store entry timestamp. */
export type ReadSessionUpdatedAt = (params: {
  storePath: string;
  sessionKey: string;
}) => number | undefined;
export type RecordSessionMetaFromInbound = (
  params: RecordInboundSessionMetaParams,
) => Promise<SessionEntry | null>;

export type UpdateLastRoute = (
  params: UpdateSessionLastRouteParams,
) => Promise<SessionEntry | null>;
