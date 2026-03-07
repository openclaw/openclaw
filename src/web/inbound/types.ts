import type { AnyMessageContent } from "@whiskeysockets/baileys";
import type { NormalizedLocation } from "../../channels/location.js";

export type WebListenerCloseReason = {
  status?: number;
  isLoggedOut: boolean;
  error?: unknown;
};

/**
 * Raw inbound message emitted BEFORE access control filtering.
 * This is an observe-only hook; it cannot influence message routing or responses.
 */
export type RawInboundMessage = {
  /** Channel this message came from */
  channel: "whatsapp";
  /** Account ID */
  accountId: string;
  /** Chat JID (group or individual) */
  chatId: string;
  /** Whether this is a group message */
  group: boolean;
  /** Group subject/name if available */
  groupSubject?: string;
  /** Sender JID */
  senderJid?: string;
  /** Sender E164 phone number if resolved */
  senderE164?: string;
  /** Sender push name */
  senderName?: string;
  /** Message body text (extracted) */
  body: string;
  /** Message timestamp (ms) */
  timestampMs?: number;
  /** Message ID */
  messageId?: string;
  /** Whether message was from the bot itself */
  fromMe: boolean;
  /** Always `false` in the current implementation — this hook fires before access control runs. Reserved for future use. */
  accessAllowed: boolean;
};

export type WebInboundMessage = {
  id?: string;
  from: string; // conversation id: E.164 for direct chats, group JID for groups
  conversationId: string; // alias for clarity (same as from)
  to: string;
  accountId: string;
  body: string;
  pushName?: string;
  timestamp?: number;
  chatType: "direct" | "group";
  chatId: string;
  senderJid?: string;
  senderE164?: string;
  senderName?: string;
  replyToId?: string;
  replyToBody?: string;
  replyToSender?: string;
  replyToSenderJid?: string;
  replyToSenderE164?: string;
  groupSubject?: string;
  groupParticipants?: string[];
  mentionedJids?: string[];
  selfJid?: string | null;
  selfE164?: string | null;
  fromMe?: boolean;
  location?: NormalizedLocation;
  sendComposing: () => Promise<void>;
  reply: (text: string) => Promise<void>;
  sendMedia: (payload: AnyMessageContent) => Promise<void>;
  mediaPath?: string;
  mediaType?: string;
  mediaFileName?: string;
  mediaUrl?: string;
  wasMentioned?: boolean;
};
