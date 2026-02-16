import type { AnyMessageContent } from "@whiskeysockets/baileys";
import type { NormalizedLocation } from "../../channels/location.js";

export type WebListenerCloseReason = {
  status?: number;
  isLoggedOut: boolean;
  error?: unknown;
};

export type WebInboundReaction = {
  accountId: string;
  /** JID of the chat where reaction occurred */
  chatId: string;
  /** E164 of the person who reacted */
  reactorE164: string | null;
  /** JID of the person who reacted */
  reactorJid: string | null;
  /** Push name (display name) of reactor if available */
  reactorName?: string;
  /** The emoji reaction (empty string = removed) */
  emoji: string;
  /** Message ID that was reacted to */
  targetMessageId: string;
  /** Whether the reaction was added or removed */
  action: "add" | "remove";
  /** Timestamp of the reaction */
  timestampMs?: number;
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
