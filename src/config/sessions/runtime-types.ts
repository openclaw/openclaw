import type { MsgContext } from "../../auto-reply/templating.js";
import type { ChannelRouteRef } from "../../plugin-sdk/channel-route.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { GroupKeyResolution, SessionEntry } from "./types.js";

export type RecordInboundSessionMetaParams = {
  /** Set false to only patch existing entries; missing sessions stay absent. */
  createIfMissing?: boolean;
  ctx: MsgContext;
  groupResolution?: GroupKeyResolution | null;
  /** Canonical or alias session key for the inbound conversation. */
  sessionKey: string;
  /** Explicit store target for file-backed stores and SQLite migration adapters. */
  storePath: string;
  /** Live caller authority checked by the existing write admission owner. */
  assertCommitAllowed?: () => void;
};

export type UpdateSessionLastRouteParams = Omit<RecordInboundSessionMetaParams, "ctx"> & {
  accountId?: string;
  channel?: string;
  /** Optional inbound context whose session metadata is derived alongside the route. */
  ctx?: MsgContext;
  /** Explicit delivery context merged over the persisted session fallback. */
  deliveryContext?: DeliveryContext;
  route?: ChannelRouteRef;
  threadId?: string | number;
  to?: string;
};

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
