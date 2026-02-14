import type { Message } from "@grammyjs/types";
import type { Bot } from "grammy";
import type { OpenClawConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { StoredBusinessConnection, StoredBusinessMessage } from "./types.js";
import { danger, logVerbose } from "../../globals.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveBusinessStorageDir, saveBusinessConnection } from "./connection-store.js";
import {
  appendBusinessMessage,
  appendDeletionMarker,
  maybePruneChatMessages,
  updateChatMeta,
} from "./message-store.js";

const log = createSubsystemLogger("telegram/business");

function resolveBusinessEnabled(cfg: OpenClawConfig): boolean {
  return cfg.channels?.telegram?.business?.enabled === true;
}

/**
 * Determine message direction by comparing `from.id` with `chat.id`.
 * In business mode private chats, `chat.id` is the contact's user ID.
 * If the sender matches the chat, it's incoming (contact sent it).
 * Otherwise it's outgoing (operator sent it).
 */
function resolveDirection(msg: Message): "incoming" | "outgoing" {
  const fromId = msg.from?.id;
  const chatId = msg.chat?.id;
  if (fromId != null && chatId != null && fromId !== chatId) {
    return "outgoing";
  }
  return "incoming";
}

function extractStoredMessage(
  msg: Message,
  businessConnectionId: string,
  event: "new" | "edited",
): StoredBusinessMessage {
  return {
    messageId: msg.message_id,
    date: msg.date,
    storedAt: Date.now(),
    fromId: msg.from?.id ?? 0,
    fromFirstName: msg.from?.first_name ?? "",
    fromLastName: msg.from?.last_name,
    fromUsername: msg.from?.username,
    text: msg.text,
    caption: msg.caption,
    direction: resolveDirection(msg),
    replyToMessageId: msg.reply_to_message?.message_id,
    businessConnectionId,
    event,
  };
}

export function registerTelegramBusinessHandlers(params: {
  bot: Bot;
  cfg: OpenClawConfig;
  accountId: string;
  runtime: RuntimeEnv;
  shouldSkipUpdate: (ctx: { update?: { update_id?: number } }) => boolean;
}): void {
  const { bot, cfg, accountId, runtime } = params;
  const baseDir = resolveBusinessStorageDir(cfg, accountId);

  // ---- BusinessConnection: operator connects/disconnects the bot ----
  bot.on("business_connection", (ctx) => {
    try {
      const conn = ctx.businessConnection;
      if (!conn) {
        return;
      }

      const stored: StoredBusinessConnection = {
        id: conn.id,
        userId: conn.user.id,
        userChatId: conn.user_chat_id,
        firstName: conn.user.first_name,
        lastName: conn.user.last_name,
        username: conn.user.username,
        date: conn.date,
        isEnabled: conn.is_enabled,
        rights: conn.rights
          ? {
              canReply: conn.rights.can_reply ?? false,
              canReadMessages: conn.rights.can_read_messages ?? false,
              canDeleteOutgoingMessages: conn.rights.can_delete_outgoing_messages ?? false,
              canDeleteAllMessages: conn.rights.can_delete_all_messages ?? false,
            }
          : undefined,
        updatedAt: Date.now(),
      };
      saveBusinessConnection(baseDir, stored);
      log.info(
        `business connection ${conn.is_enabled ? "connected" : "disconnected"}: ${conn.user.first_name} (${conn.user.id})`,
      );
    } catch (err) {
      runtime.error?.(danger(`business_connection handler failed: ${String(err)}`));
    }
  });

  // ---- business_message: new message in operator's personal chat ----
  bot.on("business_message", (ctx) => {
    try {
      if (!resolveBusinessEnabled(cfg)) {
        return;
      }

      const msg = ctx.update.business_message;
      if (!msg) {
        return;
      }

      const businessConnectionId = msg.business_connection_id;
      if (!businessConnectionId) {
        return;
      }

      const chatId = msg.chat.id;
      const stored = extractStoredMessage(msg, businessConnectionId, "new");
      appendBusinessMessage(baseDir, chatId, stored);

      updateChatMeta(baseDir, chatId, {
        firstName: msg.chat.first_name ?? "",
        lastName: msg.chat.last_name,
        username: msg.chat.username,
        lastMessageAt: Date.now(),
        incrementCount: true,
      });

      // Enforce maxMessagesPerChat / maxAgeDays limits.
      const bizCfg = cfg.channels?.telegram?.business;
      maybePruneChatMessages(baseDir, chatId, {
        maxMessages: bizCfg?.maxMessagesPerChat,
        maxAgeDays: bizCfg?.maxAgeDays,
      });

      logVerbose(
        `telegram business: stored ${stored.direction} message in chat ${chatId} (msg ${msg.message_id})`,
      );
    } catch (err) {
      runtime.error?.(danger(`business_message handler failed: ${String(err)}`));
    }
  });

  // ---- edited_business_message: message edited in operator's chat ----
  bot.on("edited_business_message", (ctx) => {
    try {
      if (!resolveBusinessEnabled(cfg)) {
        return;
      }

      const msg = ctx.update.edited_business_message;
      if (!msg) {
        return;
      }

      const businessConnectionId = msg.business_connection_id;
      if (!businessConnectionId) {
        return;
      }

      const chatId = msg.chat.id;
      const stored = extractStoredMessage(msg, businessConnectionId, "edited");
      appendBusinessMessage(baseDir, chatId, stored);

      logVerbose(
        `telegram business: stored edited message in chat ${chatId} (msg ${msg.message_id})`,
      );
    } catch (err) {
      runtime.error?.(danger(`edited_business_message handler failed: ${String(err)}`));
    }
  });

  // ---- deleted_business_messages: messages deleted in operator's chat ----
  bot.on("deleted_business_messages", (ctx) => {
    try {
      if (!resolveBusinessEnabled(cfg)) {
        return;
      }

      const deleted = ctx.update.deleted_business_messages;
      if (!deleted) {
        return;
      }

      const chatId = deleted.chat.id;
      appendDeletionMarker(baseDir, chatId, deleted.message_ids, deleted.business_connection_id);

      logVerbose(
        `telegram business: marked ${deleted.message_ids.length} message(s) deleted in chat ${chatId}`,
      );
    } catch (err) {
      runtime.error?.(danger(`deleted_business_messages handler failed: ${String(err)}`));
    }
  });
}
