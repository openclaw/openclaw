import type { MsgContext } from "../auto-reply/templating.js";
import {
  recordSessionMetaFromInbound,
  type GroupKeyResolution,
  type SessionEntry,
  updateLastRoute,
} from "../config/sessions.js";

function normalizeSessionStoreKey(sessionKey: string): string {
  return sessionKey.trim().toLowerCase();
}

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
  const canonicalSessionKey = normalizeSessionStoreKey(sessionKey);
  void recordSessionMetaFromInbound({
    storePath,
    sessionKey: canonicalSessionKey,
    ctx,
    groupResolution,
    createIfMissing,
  }).catch(params.onRecordError);

  const update = params.updateLastRoute;
  if (!update) {
    return;
  }
  const targetSessionKey = normalizeSessionStoreKey(update.sessionKey);
  await updateLastRoute({
    storePath,
    sessionKey: targetSessionKey,
    deliveryContext: {
      channel: update.channel,
      to: update.to,
      accountId: update.accountId,
      threadId: update.threadId,
    },
    // Avoid leaking inbound origin metadata into a different target session.
    ctx: targetSessionKey === canonicalSessionKey ? ctx : undefined,
    groupResolution,
  });
}
