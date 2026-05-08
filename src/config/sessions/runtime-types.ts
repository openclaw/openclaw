import type { MsgContext } from "../../auto-reply/templating.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { SessionEntry, GroupKeyResolution } from "./types.js";

export type ReadSessionUpdatedAt = (params: {
  agentId?: string;
  sessionKey: string;
}) => number | undefined;

export type RecordSessionMetaFromInbound = (params: {
  agentId?: string;
  sessionKey: string;
  ctx: MsgContext;
  groupResolution?: GroupKeyResolution | null;
  createIfMissing?: boolean;
}) => Promise<SessionEntry | null>;

export type UpdateLastRoute = (params: {
  agentId?: string;
  sessionKey: string;
  channel?: SessionEntry["lastChannel"];
  to?: string;
  accountId?: string;
  threadId?: string | number;
  deliveryContext?: DeliveryContext;
  ctx?: MsgContext;
  groupResolution?: GroupKeyResolution | null;
  createIfMissing?: boolean;
}) => Promise<SessionEntry | null>;
