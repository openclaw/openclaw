import { randomUUID } from "node:crypto";

import type { AnyMessageContent } from "@whiskeysockets/baileys";

import { logVerbose } from "../globals.js";
import { logInfo } from "../logger.js";
import { getChildLogger } from "../logging.js";
import { toWhatsappJid } from "../utils.js";
import { getActiveWebListener } from "./active-listener.js";
import { loadWebMedia } from "./media.js";
import { createWaSocket, waitForWaConnection } from "./session.js";

export async function sendMessageWhatsApp(
  to: string,
  body: string,
  options: { verbose: boolean; mediaUrl?: string },
): Promise<{ messageId: string; toJid: string }> {
  const correlationId = randomUUID();
  const active = getActiveWebListener();
  const usingActive = Boolean(active);
  const sock = usingActive
    ? null
    : await createWaSocket(false, options.verbose);
  const logger = getChildLogger({
    module: "web-outbound",
    correlationId,
    to,
  });
  try {
    const jid = toWhatsappJid(to);
    if (!usingActive) {
      logInfo("🔌 Connecting to WhatsApp Web…");
      logger.info("connecting to whatsapp web");
      if (!sock) {
        throw new Error("WhatsApp socket unavailable");
      }
      await waitForWaConnection(sock);
      try {
        await sock.sendPresenceUpdate("composing", jid);
      } catch (err) {
        logVerbose(`Presence update skipped: ${String(err)}`);
      }
    }
    let payload: AnyMessageContent = { text: body };
    if (options.mediaUrl) {
      const media = await loadWebMedia(options.mediaUrl);
      const caption = body || undefined;
      if (media.kind === "audio") {
        // WhatsApp expects explicit opus codec for PTT voice notes.
        const mimetype =
          media.contentType === "audio/ogg"
            ? "audio/ogg; codecs=opus"
            : (media.contentType ?? "application/octet-stream");
        payload = { audio: media.buffer, ptt: true, mimetype };
      } else if (media.kind === "video") {
        const mimetype = media.contentType ?? "application/octet-stream";
        payload = {
          video: media.buffer,
          caption,
          mimetype,
        };
      } else if (media.kind === "image") {
        const mimetype = media.contentType ?? "application/octet-stream";
        payload = {
          image: media.buffer,
          caption,
          mimetype,
        };
      } else {
        // Fallback to document for anything else (pdf, etc.).
        const fileName = media.fileName ?? "file";
        const mimetype = media.contentType ?? "application/octet-stream";
        payload = {
          document: media.buffer,
          fileName,
          caption,
          mimetype,
        };
      }
    }
    logInfo(
      `📤 Sending via web session -> ${jid}${options.mediaUrl ? " (media)" : ""}`,
    );
    logger.info(
      { jid, hasMedia: Boolean(options.mediaUrl) },
      "sending message",
    );
    const result = usingActive
      ? await (async () => {
          if (!active) throw new Error("Active web listener missing");
          let mediaBuffer: Buffer | undefined;
          let mediaType: string | undefined;
          if (options.mediaUrl) {
            const media = await loadWebMedia(options.mediaUrl);
            mediaBuffer = media.buffer;
            mediaType = media.contentType;
          }
          await active.sendComposingTo(to);
          return active.sendMessage(to, body, mediaBuffer, mediaType);
        })()
      : await (async () => {
          if (!sock) throw new Error("WhatsApp socket unavailable");
          return sock.sendMessage(jid, payload);
        })();
    const messageId = usingActive
      ? ((result as { messageId?: string })?.messageId ?? "unknown")
      : ((result as { key?: { id?: string } } | undefined)?.key?.id ??
        "unknown");
    logInfo(
      `✅ Sent via web session. Message ID: ${messageId} -> ${jid}${options.mediaUrl ? " (media)" : ""}`,
    );
    logger.info({ jid, messageId }, "sent message");
    return { messageId, toJid: jid };
  } finally {
    if (!usingActive) {
      try {
        sock?.ws?.close();
      } catch (err) {
        logVerbose(`Socket close failed: ${String(err)}`);
      }
    }
  }
}
