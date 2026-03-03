import { recordSessionMetaFromInbound, updateLastRoute, } from "../config/sessions.js";
function normalizeSessionStoreKey(sessionKey) {
    return sessionKey.trim().toLowerCase();
}
export async function recordInboundSession(params) {
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
