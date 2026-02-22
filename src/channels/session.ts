import type { MsgContext } from "../auto-reply/templating.js";
import {
  recordSessionMetaFromInbound,
  type GroupKeyResolution,
  type SessionEntry,
  updateLastRoute,
} from "../config/sessions.js";
import { isInternalMessageChannel } from "../utils/message-channel.js";

export type InboundLastRouteUpdate = {
  sessionKey: string;
  channel: SessionEntry["lastChannel"];
  to: string;
  accountId?: string;
  threadId?: string | number;
};

export async function recordInboundSession(params: {
  storePath: string;
  sessionKey: string;
  ctx: MsgContext;
  groupResolution?: GroupKeyResolution | null;
  createIfMissing?: boolean;
  updateLastRoute?: InboundLastRouteUpdate;
  onRecordError: (err: unknown) => void;
}): Promise<void> {
  const { storePath, sessionKey, ctx, groupResolution, createIfMissing } = params;
  void recordSessionMetaFromInbound({
    storePath,
    sessionKey,
    ctx,
    groupResolution,
    createIfMissing,
  }).catch(params.onRecordError);

  const update = params.updateLastRoute;
  if (!update) {
    return;
  }
  // WebChat (INTERNAL_MESSAGE_CHANNEL) is a cross-channel viewer that replies
  // via WebSocket, not through deliveryContext routing.  Updating the session's
  // delivery fields to "webchat" would break announce/heartbeat/cron delivery
  // for whichever external channel actually owns the conversation.
  if (isInternalMessageChannel(update.channel)) {
    return;
  }
  await updateLastRoute({
    storePath,
    sessionKey: update.sessionKey,
    deliveryContext: {
      channel: update.channel,
      to: update.to,
      accountId: update.accountId,
      threadId: update.threadId,
    },
    // Avoid leaking inbound origin metadata into a different target session.
    ctx: update.sessionKey === sessionKey ? ctx : undefined,
    groupResolution,
  });
}
