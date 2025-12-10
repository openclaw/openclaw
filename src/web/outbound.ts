import { randomUUID } from "node:crypto";

import { logInfo } from "../logger.js";
import { getChildLogger } from "../logging.js";
import { toWhatsappJid } from "../utils.js";
import { getActiveWebListener } from "./active-listener.js";
import { loadWebMedia } from "./media.js";

export async function sendMessageWhatsApp(
  to: string,
  body: string,
  options: { verbose: boolean; mediaUrl?: string },
): Promise<{ messageId: string; toJid: string }> {
  let text = body;
  const correlationId = randomUUID();
  const active = getActiveWebListener();
  if (!active) {
    throw new Error(
      "No active gateway listener. Start the gateway before sending WhatsApp messages.",
    );
  }
  const logger = getChildLogger({
    module: "web-outbound",
    correlationId,
    to,
  });
  try {
    const jid = toWhatsappJid(to);
    let mediaBuffer: Buffer | undefined;
    let mediaType: string | undefined;
    if (options.mediaUrl) {
      const media = await loadWebMedia(options.mediaUrl);
      const caption = text || undefined;
      mediaBuffer = media.buffer;
      mediaType = media.contentType;
      if (media.kind === "audio") {
        // WhatsApp expects explicit opus codec for PTT voice notes.
        mediaType =
          media.contentType === "audio/ogg"
            ? "audio/ogg; codecs=opus"
            : media.contentType ?? "application/octet-stream";
      } else if (media.kind === "video") {
        text = caption ?? "";
      } else if (media.kind === "image") {
        text = caption ?? "";
      } else {
        text = caption ?? "";
      }
    }
    logInfo(
      `📤 Sending via web session -> ${jid}${options.mediaUrl ? " (media)" : ""}`,
    );
    logger.info(
      { jid, hasMedia: Boolean(options.mediaUrl) },
      "sending message",
    );
    const result = await (async () => {
      if (!active) throw new Error("Active web listener missing");
      let mediaBuffer: Buffer | undefined;
      let mediaType: string | undefined;
      if (options.mediaUrl) {
        const media = await loadWebMedia(options.mediaUrl);
        mediaBuffer = media.buffer;
        mediaType = media.contentType;
      }
      await active.sendComposingTo(to);
      return active.sendMessage(to, text, mediaBuffer, mediaType);
    })();
    const messageId =
      (result as { messageId?: string })?.messageId ?? "unknown";
    logInfo(
      `✅ Sent via web session. Message ID: ${messageId} -> ${jid}${options.mediaUrl ? " (media)" : ""}`,
    );
    logger.info({ jid, messageId }, "sent message");
    return { messageId, toJid: jid };
  } catch (err) {
    logger.error(
      { err: String(err), to, hasMedia: Boolean(options.mediaUrl) },
      "failed to send via web session",
    );
    throw err;
  }
}
