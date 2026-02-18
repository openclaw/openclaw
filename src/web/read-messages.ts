import type { proto } from "@whiskeysockets/baileys";
import { getMessageStore } from "./inbound/message-store.js";

function extractText(message: proto.IMessage | undefined): string {
  if (!message) return "";
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    ""
  );
}

function hasMedia(message: proto.IMessage | undefined): boolean {
  if (!message) return false;
  return Boolean(
    message.imageMessage ||
    message.videoMessage ||
    message.documentMessage ||
    message.audioMessage ||
    message.stickerMessage,
  );
}

function getMediaType(message: proto.IMessage | undefined): string | undefined {
  if (!message) return undefined;
  if (message.imageMessage) return "image";
  if (message.videoMessage) return "video";
  if (message.documentMessage) return "document";
  if (message.audioMessage) return "audio";
  if (message.stickerMessage) return "sticker";
  return undefined;
}

export type WhatsAppMessageSummary = {
  id?: string;
  from?: string;
  to?: string;
  body?: string;
  timestamp?: number;
  hasMedia?: boolean;
  mediaType?: string;
  fileName?: string;
};

/**
 * Read recent messages from a WhatsApp chat using the message store.
 */
export async function readWhatsAppMessages(
  chatJid: string,
  options: {
    accountId: string;
    limit?: number;
  },
): Promise<{ messages: WhatsAppMessageSummary[] }> {
  const messageStore = getMessageStore(options.accountId);
  const limit = options.limit ?? 20;

  const storedMessages = messageStore.getMessagesForChat(chatJid, limit);

  const messages: WhatsAppMessageSummary[] = storedMessages.map((stored) => {
    const msg = stored.message;
    const message = msg.message as proto.IMessage | undefined;
    const body = extractText(message);
    const mediaPresent = hasMedia(message);
    const mediaTypeValue = getMediaType(message);
    const fileName = message?.documentMessage?.fileName ?? undefined;

    return {
      id: msg.key?.id ?? undefined,
      from: msg.key?.remoteJid ?? undefined,
      to: msg.key?.remoteJid ?? undefined, // In WhatsApp, this is the chat JID
      body,
      timestamp: msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : stored.timestamp,
      hasMedia: mediaPresent,
      mediaType: mediaTypeValue,
      fileName,
    };
  });

  return { messages };
}
