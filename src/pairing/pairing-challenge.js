import { buildPairingReply } from "./pairing-messages.js";
/**
 * Shared pairing challenge issuance for DM pairing policy pathways.
 * Ensures every channel follows the same create-if-missing + reply flow.
 */
export async function issuePairingChallenge(params) {
    const { code, created } = await params.upsertPairingRequest({
        id: params.senderId,
        meta: params.meta,
    });
    if (!created) {
        return { created: false };
    }
    params.onCreated?.({ code });
    const replyText = params.buildReplyText?.({ code, senderIdLine: params.senderIdLine }) ??
        buildPairingReply({
            channel: params.channel,
            idLine: params.senderIdLine,
            code,
        });
    try {
        await params.sendPairingReply(replyText);
    }
    catch (err) {
        params.onReplyError?.(err);
    }
    return { created: true, code };
}
