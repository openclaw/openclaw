import { Bot } from "grammy";
import { loadConfig } from "../config/config.js";
import { recordChannelActivity } from "../infra/channel-activity.js";
import { createTelegramRetryRunner } from "../infra/retry-policy.js";
import { resolveTelegramAccount } from "./accounts.js";
import { normalizeChatId, resolveToken, resolveTelegramClientOptions } from "./send.js";

/**
 * Pin a message in a Telegram chat.
 * @param chatId - Chat ID where the message is located
 * @param messageId - ID of the message to pin
 * @param opts - Optional configuration
 */
export async function pinMessageTelegram(
  chatId: string | number,
  messageId: number,
  opts: { token?: string; accountId?: string; disableNotification?: boolean } = {},
): Promise<{ ok: boolean }> {
  const cfg = loadConfig();
  const account = resolveTelegramAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken(opts.token, account);
  const normalizedChatId = normalizeChatId(String(chatId));
  const client = resolveTelegramClientOptions(account);
  const api = new Bot(token, client ? { client } : undefined).api;

  const request = createTelegramRetryRunner({
    configRetry: account.config.retry,
  });

  const params: Record<string, unknown> = {
    chat_id: normalizedChatId,
    message_id: Math.trunc(messageId),
  };

  if (opts.disableNotification !== undefined) {
    params.disable_notification = opts.disableNotification;
  }

  await request(
    () => api.pinChatMessage(normalizedChatId, Math.trunc(messageId), params),
    "pinMessage",
  );

  recordChannelActivity({
    channel: "telegram",
    accountId: account.accountId,
    direction: "outbound",
  });

  return { ok: true };
}

/**
 * Unpin a message in a Telegram chat.
 * @param chatId - Chat ID where the message is located
 * @param messageId - ID of the message to unpin
 * @param opts - Optional configuration
 */
export async function unpinMessageTelegram(
  chatId: string | number,
  messageId: number,
  opts: { token?: string; accountId?: string } = {},
): Promise<{ ok: boolean }> {
  const cfg = loadConfig();
  const account = resolveTelegramAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken(opts.token, account);
  const normalizedChatId = normalizeChatId(String(chatId));
  const client = resolveTelegramClientOptions(account);
  const api = new Bot(token, client ? { client } : undefined).api;

  const request = createTelegramRetryRunner({
    configRetry: account.config.retry,
  });

  await request(
    () => api.unpinChatMessage(normalizedChatId, Math.trunc(messageId)),
    "unpinMessage",
  );

  recordChannelActivity({
    channel: "telegram",
    accountId: account.accountId,
    direction: "outbound",
  });

  return { ok: true };
}
