import type { proto, WAMessage } from "@whiskeysockets/baileys";
import { downloadMediaMessage, normalizeMessageContent } from "@whiskeysockets/baileys";
import { logVerbose } from "../../globals.js";
import type { createWaSocket } from "../session.js";
import { getMessageStore } from "./message-store.js";

function unwrapMessage(message: proto.IMessage | undefined): proto.IMessage | undefined {
  const normalized = normalizeMessageContent(message);
  return normalized;
}

function resolveMediaMimetype(message: proto.IMessage): string | undefined {
  const explicit =
    message.imageMessage?.mimetype ??
    message.videoMessage?.mimetype ??
    message.documentMessage?.mimetype ??
    message.audioMessage?.mimetype ??
    message.stickerMessage?.mimetype ??
    undefined;
  if (explicit) {
    return explicit;
  }
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

/**
 * Download media from a specific message using the message store.
 */
export async function downloadMediaById(
  chatJid: string,
  messageId: string,
  accountId: string,
  sock: Awaited<ReturnType<typeof createWaSocket>>,
): Promise<{ buffer: Buffer; mimetype?: string; fileName?: string } | null> {
  try {
    // Get the message from the store
    const messageStore = getMessageStore(accountId);
    const targetMessage = messageStore.get(chatJid, messageId);

    if (!targetMessage) {
      logVerbose(`Message ${messageId} not found in store for chat ${chatJid}`);
      return null;
    }

    const message = unwrapMessage(targetMessage.message as proto.IMessage | undefined);
    if (!message) {
      logVerbose(`No message content for ${messageId}`);
      return null;
    }

    const mimetype = resolveMediaMimetype(message);
    const fileName = message.documentMessage?.fileName ?? undefined;

    // Check if message has media
    if (
      !message.imageMessage &&
      !message.videoMessage &&
      !message.documentMessage &&
      !message.audioMessage &&
      !message.stickerMessage
    ) {
      logVerbose(`Message ${messageId} has no media`);
      return null;
    }

    const buffer = await downloadMediaMessage(
      targetMessage as WAMessage,
      "buffer",
      {},
      {
        reuploadRequest: sock.updateMediaMessage,
        logger: sock.logger,
      },
    );

    return { buffer, mimetype, fileName };
  } catch (err) {
    logVerbose(`downloadMediaById failed: ${String(err)}`);
    return null;
  }
}
