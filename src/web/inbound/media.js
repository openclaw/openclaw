import { downloadMediaMessage, normalizeMessageContent } from "@whiskeysockets/baileys";
import { logVerbose } from "../../globals.js";
function unwrapMessage(message) {
    const normalized = normalizeMessageContent(message);
    return normalized;
}
/**
 * Resolve the MIME type for an inbound media message.
 * Falls back to WhatsApp's standard formats when Baileys omits the MIME.
 */
function resolveMediaMimetype(message) {
    const explicit = message.imageMessage?.mimetype ??
        message.videoMessage?.mimetype ??
        message.documentMessage?.mimetype ??
        message.audioMessage?.mimetype ??
        message.stickerMessage?.mimetype ??
        undefined;
    if (explicit) {
        return explicit;
    }
    // WhatsApp voice messages (PTT) and audio use OGG Opus by default
    if (message.audioMessage) {
        return "audio/ogg; codecs=opus";
    }
    if (message.imageMessage) {
        return "image/jpeg";
    }
    if (message.videoMessage) {
        return "video/mp4";
    }
    if (message.stickerMessage) {
        return "image/webp";
    }
    return undefined;
}
export async function downloadInboundMedia(msg, sock) {
    const message = unwrapMessage(msg.message);
    if (!message) {
        return undefined;
    }
    const mimetype = resolveMediaMimetype(message);
    const fileName = message.documentMessage?.fileName ?? undefined;
    if (!message.imageMessage &&
        !message.videoMessage &&
        !message.documentMessage &&
        !message.audioMessage &&
        !message.stickerMessage) {
        return undefined;
    }
    try {
        const buffer = await downloadMediaMessage(msg, "buffer", {}, {
            reuploadRequest: sock.updateMediaMessage,
            logger: sock.logger,
        });
        return { buffer, mimetype, fileName };
    }
    catch (err) {
        logVerbose(`downloadMediaMessage failed: ${String(err)}`);
        return undefined;
    }
}
