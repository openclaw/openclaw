import { type Message, type UserFromGetMe } from "@grammyjs/types";
import { isAbortRequestText } from "../auto-reply/reply/abort.js";
import { resolveTelegramForumThreadId } from "./bot/helpers.js";

export type TelegramSequentialKeyContext = {
  chat?: { id?: number };
  me?: UserFromGetMe;
  message?: Message;
  channelPost?: Message;
  editedChannelPost?: Message;
  update?: {
    message?: Message;
    edited_message?: Message;
    channel_post?: Message;
    edited_channel_post?: Message;
    callback_query?: { data?: string; message?: Message };
    message_reaction?: { chat?: { id?: number } };
  };
};

const APPROVAL_CALLBACK_COMMAND_RE = /^\/approve\s+\S+\s+(allow-once|allow-always|deny)\s*$/i;

function isControlCallbackQueryData(data: string | undefined, botUsername?: string): boolean {
  const normalized = data?.trim();
  if (!normalized) {
    return false;
  }
  if (APPROVAL_CALLBACK_COMMAND_RE.test(normalized)) {
    return true;
  }
  return isAbortRequestText(normalized, botUsername ? { botUsername } : undefined);
}

export function getTelegramSequentialKey(ctx: TelegramSequentialKeyContext): string {
  const reaction = ctx.update?.message_reaction;
  if (reaction?.chat?.id) {
    return `telegram:${reaction.chat.id}`;
  }
  const callbackMsg = ctx.update?.callback_query?.message;
  if (callbackMsg?.chat?.id) {
    const callbackData = ctx.update?.callback_query?.data;
    const isControlCallback = isControlCallbackQueryData(callbackData, ctx.me?.username);
    const callbackChatId = callbackMsg.chat.id;
    const callbackIsGroup =
      callbackMsg.chat.type === "group" || callbackMsg.chat.type === "supergroup";
    const callbackThreadId = callbackIsGroup
      ? resolveTelegramForumThreadId({
          isForum: callbackMsg.chat.is_forum,
          messageThreadId: callbackMsg.message_thread_id,
        })
      : callbackMsg.message_thread_id;
    if (callbackThreadId != null) {
      return isControlCallback
        ? `telegram:${callbackChatId}:topic:${callbackThreadId}:control`
        : `telegram:${callbackChatId}:topic:${callbackThreadId}`;
    }
    return isControlCallback ? `telegram:${callbackChatId}:control` : `telegram:${callbackChatId}`;
  }
  const msg =
    ctx.message ??
    ctx.channelPost ??
    ctx.editedChannelPost ??
    ctx.update?.message ??
    ctx.update?.edited_message ??
    ctx.update?.channel_post ??
    ctx.update?.edited_channel_post;
  const chatId = msg?.chat?.id ?? ctx.chat?.id;
  const rawText = msg?.text ?? msg?.caption;
  const botUsername = ctx.me?.username;
  if (isAbortRequestText(rawText, botUsername ? { botUsername } : undefined)) {
    if (typeof chatId === "number") {
      return `telegram:${chatId}:control`;
    }
    return "telegram:control";
  }
  const isGroup = msg?.chat?.type === "group" || msg?.chat?.type === "supergroup";
  const messageThreadId = msg?.message_thread_id;
  const isForum = msg?.chat?.is_forum;
  const threadId = isGroup
    ? resolveTelegramForumThreadId({ isForum, messageThreadId })
    : messageThreadId;
  if (typeof chatId === "number") {
    return threadId != null ? `telegram:${chatId}:topic:${threadId}` : `telegram:${chatId}`;
  }
  return "telegram:unknown";
}
