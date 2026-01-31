import { createDedupeCache } from "../infra/dedupe.js";
import type { TelegramContext, TelegramMessage } from "./bot/types.js";

const MEDIA_GROUP_TIMEOUT_MS = 500;
const RECENT_TELEGRAM_UPDATE_TTL_MS = 5 * 60_000;
const RECENT_TELEGRAM_UPDATE_MAX = 2000;

export type MediaGroupEntry = {
  messages: Array<{
    msg: TelegramMessage;
    ctx: TelegramContext;
  }>;
  timer: ReturnType<typeof setTimeout>;
};

export type TelegramUpdateKeyContext = {
  update?: {
    update_id?: number;
    message?: TelegramMessage;
    edited_message?: TelegramMessage;
  };
  update_id?: number;
  message?: TelegramMessage;
  callbackQuery?: { id?: string; message?: TelegramMessage };
};

export const resolveTelegramUpdateId = (ctx: TelegramUpdateKeyContext) =>
  ctx.update?.update_id ?? ctx.update_id;

export const buildTelegramUpdateKey = (ctx: TelegramUpdateKeyContext) => {
  const updateId = resolveTelegramUpdateId(ctx);
  if (typeof updateId === "number") return `update:${updateId}`;
  const callbackId = ctx.callbackQuery?.id;
  if (callbackId) return `callback:${callbackId}`;
  const msg =
    ctx.message ?? ctx.update?.message ?? ctx.update?.edited_message ?? ctx.callbackQuery?.message;
  const chatId = msg?.chat?.id;
  const messageId = msg?.message_id;
  if (typeof chatId !== "undefined" && typeof messageId === "number") {
    return `message:${chatId}:${messageId}`;
  }
  return undefined;
};

export const createTelegramUpdateDedupe = () =>
  createDedupeCache({
    ttlMs: RECENT_TELEGRAM_UPDATE_TTL_MS,
    maxSize: RECENT_TELEGRAM_UPDATE_MAX,
  });

export { MEDIA_GROUP_TIMEOUT_MS };
