/**
 * Live Message Capture
 * Bridges Baileys events to the SQLite history database
 */

import type { BaileysEventEmitter, WAMessage, Chat, Contact } from "@whiskeysockets/baileys";
import { jidNormalizedUser } from "@whiskeysockets/baileys";
import { getChildLogger } from "../logging.js";
import {
  insertMessage,
  upsertContact,
  upsertChat,
  getContactName,
  getChatName,
  type MessageRecord,
} from "./db.js";

const logger = getChildLogger({ module: "wa-history" });

/**
 * Extract text content from a WhatsApp message
 */
function extractTextContent(msg: WAMessage): { text: string | null; type: string } {
  const m = msg.message;
  if (!m) return { text: null, type: "unknown" };

  if (m.conversation) {
    return { text: m.conversation, type: "text" };
  }
  if (m.extendedTextMessage?.text) {
    return { text: m.extendedTextMessage.text, type: "text" };
  }
  if (m.imageMessage) {
    return { text: m.imageMessage.caption || null, type: "image" };
  }
  if (m.videoMessage) {
    return { text: m.videoMessage.caption || null, type: "video" };
  }
  if (m.documentMessage) {
    return {
      text: m.documentMessage.caption || m.documentMessage.fileName || null,
      type: "document",
    };
  }
  if (m.audioMessage) {
    return { text: null, type: m.audioMessage.ptt ? "voice" : "audio" };
  }
  if (m.stickerMessage) {
    return { text: null, type: "sticker" };
  }
  if (m.contactMessage) {
    return { text: m.contactMessage.displayName || null, type: "contact" };
  }
  if (m.locationMessage) {
    return {
      text:
        m.locationMessage.name ||
        `${m.locationMessage.degreesLatitude},${m.locationMessage.degreesLongitude}`,
      type: "location",
    };
  }
  if (m.reactionMessage) {
    return { text: m.reactionMessage.text || null, type: "reaction" };
  }
  if (m.pollCreationMessage || m.pollCreationMessageV3) {
    const poll = m.pollCreationMessage || m.pollCreationMessageV3;
    return { text: poll?.name || null, type: "poll" };
  }
  if (m.protocolMessage) {
    return { text: null, type: "protocol" };
  }

  return { text: null, type: "unknown" };
}

/**
 * Extract quoted message info
 */
function extractQuotedInfo(msg: WAMessage): { quotedId: string | null; quotedText: string | null } {
  const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
  if (!contextInfo?.quotedMessage) {
    return { quotedId: null, quotedText: null };
  }

  const quotedId = contextInfo.stanzaId || null;
  let quotedText: string | null = null;

  const qm = contextInfo.quotedMessage;
  if (qm.conversation) {
    quotedText = qm.conversation;
  } else if (qm.extendedTextMessage?.text) {
    quotedText = qm.extendedTextMessage.text;
  } else if (qm.imageMessage?.caption) {
    quotedText = qm.imageMessage.caption;
  }

  return { quotedId, quotedText };
}

/**
 * Convert WAMessage to our MessageRecord format
 */
function waMessageToRecord(msg: WAMessage, chatName?: string): MessageRecord | null {
  const key = msg.key;
  if (!key.remoteJid || !key.id) return null;

  const chatJid = jidNormalizedUser(key.remoteJid);
  const { text, type } = extractTextContent(msg);
  const { quotedId, quotedText } = extractQuotedInfo(msg);

  // Get sender info
  let senderJid: string | null = null;
  let senderName: string | null = null;
  let senderPushname: string | null = null;

  if (key.participant) {
    senderJid = jidNormalizedUser(key.participant);
  } else if (!chatJid.includes("@g.us")) {
    // DM - sender is the remoteJid if not from me
    senderJid = key.fromMe ? null : chatJid;
  }

  if (senderJid) {
    senderName = getContactName(senderJid);
  }
  senderPushname = msg.pushName || null;

  // Get timestamp
  const timestamp = msg.messageTimestamp
    ? typeof msg.messageTimestamp === "number"
      ? msg.messageTimestamp
      : Number(msg.messageTimestamp)
    : Math.floor(Date.now() / 1000);

  return {
    id: key.id,
    chat_jid: chatJid,
    chat_name: chatName || getChatName(chatJid) || undefined,
    sender_jid: senderJid || undefined,
    sender_name: senderName || undefined,
    sender_pushname: senderPushname || undefined,
    from_me: key.fromMe || false,
    timestamp,
    message_type: type,
    text_content: text || undefined,
    caption: type !== "text" ? text || undefined : undefined,
    quoted_id: quotedId || undefined,
    quoted_text: quotedText || undefined,
    raw_json: JSON.stringify(msg),
    source: "live",
  };
}

/**
 * Bind to Baileys events and capture messages to SQLite
 */
export function bindHistoryCapture(ev: BaileysEventEmitter): void {
  logger.info("Binding WhatsApp history capture to Baileys events");

  // Capture history sync on connect
  ev.on("messaging-history.set", ({ chats, contacts, messages, isLatest }) => {
    logger.info(
      { chats: chats.length, contacts: contacts.length, messages: messages.length, isLatest },
      "Received messaging history sync",
    );

    // Store contacts
    for (const c of contacts) {
      if (c.id) {
        upsertContact(jidNormalizedUser(c.id), c.name || undefined, c.notify || undefined);
      }
    }

    // Store chats
    for (const chat of chats) {
      if (chat.id) {
        upsertChat(jidNormalizedUser(chat.id), chat.name || undefined, chat.id.includes("@g.us"));
      }
    }

    // Store messages
    let stored = 0;
    for (const msg of messages) {
      const record = waMessageToRecord(msg);
      if (record) {
        try {
          insertMessage(record);
          stored++;
        } catch (err) {
          // Ignore duplicates
        }
      }
    }

    logger.info({ stored, total: messages.length }, "History sync messages stored");
  });

  // Capture new messages
  ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify" && type !== "append") return;

    for (const msg of messages) {
      const record = waMessageToRecord(msg);
      if (record) {
        try {
          insertMessage(record);
          logger.debug(
            { id: record.id, chat: record.chat_name || record.chat_jid, type: record.message_type },
            "Message captured",
          );
        } catch (err) {
          // Ignore duplicates
        }
      }
    }
  });

  // Update contacts
  ev.on("contacts.upsert", (contacts) => {
    for (const c of contacts) {
      if (c.id) {
        upsertContact(jidNormalizedUser(c.id), c.name || undefined, c.notify || undefined);
      }
    }
  });

  ev.on("contacts.update", (updates) => {
    for (const u of updates) {
      if (u.id) {
        upsertContact(jidNormalizedUser(u.id), u.name || undefined, u.notify || undefined);
      }
    }
  });

  // Update chats
  ev.on("chats.upsert", (chats) => {
    for (const chat of chats) {
      if (chat.id) {
        upsertChat(jidNormalizedUser(chat.id), chat.name || undefined, chat.id.includes("@g.us"));
      }
    }
  });

  ev.on("chats.update", (updates) => {
    for (const u of updates) {
      if (u.id) {
        upsertChat(jidNormalizedUser(u.id), u.name || undefined);
      }
    }
  });

  logger.info("WhatsApp history capture bound successfully");
}
