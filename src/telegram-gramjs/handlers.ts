/**
 * Message handlers for converting GramJS events to openclaw format.
 */

import type { GramJSMessageContext, ResolvedGramJSAccount } from "./types.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("telegram-gramjs:handlers");

/**
 * Convert GramJS message context to openclaw MsgContext.
 */
export async function convertToMsgContext(
  _gramjsContext: GramJSMessageContext,
  account: ResolvedGramJSAccount,
  accountId: string,
): Promise<MsgContext | null> {
  try {
    const {
      messageId,
      chatId,
      senderId,
      text,
      date,
      replyToId,
      isGroup,
      isChannel,
      chatTitle,
      senderUsername,
      senderFirstName,
    } = gramjsContext;

    // Skip messages without text for now (Phase 2 will handle media)
    if (!text || text.trim() === "") {
      log.verbose(`Skipping message ${messageId} (no text content)`);
      return null;
    }

    // Determine chat type
    const chatType = isGroup ? "group" : isChannel ? "channel" : "direct";

    // Skip channel messages unless explicitly configured
    // (most users want DMs and groups only)
    if (isChannel) {
      log.verbose(`Skipping channel message ${messageId} (channel messages not supported yet)`);
      return null;
    }

    // Build session key
    // - DMs: Use senderId for main session
    // - Groups: Use groupId for isolated session (per openclaw convention)
    const sessionKey = isGroup
      ? `telegram-gramjs:${accountId}:group:${chatId}`
      : `telegram-gramjs:${accountId}:${senderId}`;

    // Build From field (sender identifier)
    // Use username if available, otherwise user ID
    const from = senderUsername ? `@${senderUsername}` : String(senderId);

    // Build sender name for display
    const senderName = senderFirstName || senderUsername || String(senderId);

    // Create openclaw MsgContext
    const msgContext: MsgContext = {
      // Core message data
      Body: text,
      RawBody: text,
      CommandBody: text,
      BodyForAgent: text,
      BodyForCommands: text,

      // Identifiers
      From: from,
      To: String(chatId),
      SessionKey: sessionKey,
      AccountId: accountId,
      MessageSid: String(messageId),
      MessageSidFull: `${chatId}:${messageId}`,

      // Reply context
      ReplyToId: replyToId ? String(replyToId) : undefined,
      ReplyToIdFull: replyToId ? `${chatId}:${replyToId}` : undefined,

      // Timestamps
      Timestamp: date ? date * 1000 : Date.now(),

      // Chat metadata
      ChatType: chatType,
      ChatId: String(chatId),

      // Sender metadata (for groups)
      SenderId: senderId ? String(senderId) : undefined,
      SenderUsername: senderUsername,
      SenderName: senderName,

      // Group metadata
      GroupId: isGroup ? String(chatId) : undefined,
      GroupSubject: isGroup ? chatTitle : undefined,

      // Provider metadata
      Provider: "telegram-gramjs",
      Surface: "telegram-gramjs",
    };

    // For groups, check if bot was mentioned
    if (isGroup) {
      // TODO: Add mention detection logic
      // This requires knowing the bot's username/ID
      // For now, we'll rely on group requireMention config
      const requireMention = account.config.groups?.[String(chatId)]?.requireMention;

      if (requireMention) {
        // For now, process all group messages
        // Mention detection will be added in a follow-up
        log.verbose(`Group message requires mention check (not yet implemented)`);
      }
    }

    log.verbose(`Converted message ${messageId} from ${from} (chat: ${chatId})`);

    return msgContext;
  } catch (err) {
    log.error("Error converting GramJS message to MsgContext:", err);
    return null;
  }
}

/**
 * Extract sender info from GramJS context.
 */
export function extractSenderInfo(gramjsContext: GramJSMessageContext): {
  senderId: string;
  senderUsername?: string;
  senderName: string;
} {
  const { senderId, senderUsername, senderFirstName } = gramjsContext;

  return {
    senderId: String(senderId || "unknown"),
    senderUsername,
    senderName: senderFirstName || senderUsername || String(senderId || "unknown"),
  };
}

/**
 * Build session key for routing messages to the correct agent session.
 *
 * Rules:
 * - DMs: Use senderId (main session per user)
 * - Groups: Use groupId (isolated session per group)
 */
export function buildSessionKey(gramjsContext: GramJSMessageContext, accountId: string): string {
  const { chatId, senderId, isGroup } = gramjsContext;

  if (isGroup) {
    return `telegram-gramjs:${accountId}:group:${chatId}`;
  }

  return `telegram-gramjs:${accountId}:${senderId}`;
}

/**
 * Check if a message mentions the bot (for group messages).
 *
 * NOTE: This is a placeholder. Full implementation requires:
 * - Knowing the bot's username (from client.getMe())
 * - Parsing @mentions in message text
 * - Checking message.entities for mentions
 */
export function wasMessageMentioned(
  _gramjsContext: GramJSMessageContext,
  _botUsername?: string,
): boolean {
  // TODO: Implement mention detection
  // For now, return false (rely on requireMention config)
  return false;
}

/**
 * Extract command from message text.
 *
 * Telegram commands start with / (e.g., /start, /help)
 */
export function extractCommand(text: string): {
  isCommand: boolean;
  command?: string;
  args?: string;
} {
  const trimmed = text.trim();

  if (!trimmed.startsWith("/")) {
    return { isCommand: false };
  }

  const parts = trimmed.split(/\s+/);
  const command = parts[0].slice(1); // Remove leading /
  const args = parts.slice(1).join(" ");

  return {
    isCommand: true,
    command,
    args: args || undefined,
  };
}
