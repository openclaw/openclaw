import type { AnyMessageContent } from "@whiskeysockets/baileys";
import type { NormalizedLocation } from "../../channels/location.js";

export type WebListenerCloseReason = {
  status?: number;
  isLoggedOut: boolean;
  error?: unknown;
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
  mediaUrl?: string;
  wasMentioned?: boolean;
};

export type WebInboundReaction = {
  /** Message ID being reacted to. */
  messageId: string;
  /** Emoji text (empty string when isRemoval=true). */
  emoji: string;
  /** True if this is a reaction removal (emoji will be empty). */
  isRemoval?: boolean;
  /** JID of the chat where the reaction occurred. */
  chatJid: string;
  chatType: "direct" | "group";
  /** Account that received the reaction. */
  accountId: string;
  /** JID of the person who reacted. */
  senderJid?: string;
  /** E.164 of the person who reacted. */
  senderE164?: string;
  /** Whether the reacted message was sent by us. */
  reactedToFromMe?: boolean;
  timestamp?: number;
};
