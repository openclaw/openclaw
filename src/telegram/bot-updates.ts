import type { Message } from "@grammyjs/types";
import { createDedupeCache } from "../infra/dedupe.js";
import type { TelegramContext } from "./bot/types.js";

const MEDIA_GROUP_TIMEOUT_MS = 500;
const RECENT_TELEGRAM_UPDATE_TTL_MS = 5 * 60_000;
const RECENT_TELEGRAM_UPDATE_MAX = 2000;

export type MediaGroupEntry = {
  messages: Array<{
    msg: Message;
    ctx: TelegramContext;
    updateId?: number;
  }>;
  timer: ReturnType<typeof setTimeout>;
};

export type TelegramUpdateKeyContext = {
  update?: {
    update_id?: number;
    message?: Message;
    edited_message?: Message;
    channel_post?: Message;
    edited_channel_post?: Message;
  };
  update_id?: number;
  message?: Message;
  channelPost?: Message;
  editedChannelPost?: Message;
  callbackQuery?: { id?: string; message?: Message };
};

export const resolveTelegramUpdateId = (ctx: TelegramUpdateKeyContext) =>
  ctx.update?.update_id ?? ctx.update_id;

export const buildTelegramUpdateKey = (ctx: TelegramUpdateKeyContext) => {
  const updateId = resolveTelegramUpdateId(ctx);
  if (typeof updateId === "number") {
    return `update:${updateId}`;
  }
  const callbackId = ctx.callbackQuery?.id;
  if (callbackId) {
    return `callback:${callbackId}`;
  }
  const msg =
    ctx.message ??
    ctx.channelPost ??
    ctx.editedChannelPost ??
    ctx.update?.message ??
    ctx.update?.edited_message ??
    ctx.update?.channel_post ??
    ctx.update?.edited_channel_post ??
    ctx.callbackQuery?.message;
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

export function createTelegramUpdateOffsetTracker(params: {
  initialUpdateId?: number | null;
  onUpdateId?: (updateId: number) => void | Promise<void>;
}) {
  const recentUpdates = createTelegramUpdateDedupe();
  const initialUpdateId =
    typeof params.initialUpdateId === "number" ? params.initialUpdateId : null;
  const pendingUpdateIds = new Set<number>();
  // Buffered handlers (for example Telegram media groups) can outlive the middleware call stack.
  // Keep those update_ids pending until the deferred flush finishes so the persisted offset
  // neither retries fatal groups forever nor skips buffered work on restart.
  const deferredHoldCounts = new Map<number, number>();
  const completedWhileDeferred = new Set<number>();
  let highestCompletedUpdateId: number | null = initialUpdateId;
  let highestPersistedUpdateId: number | null = initialUpdateId;

  const maybePersistSafeWatermark = () => {
    if (typeof params.onUpdateId !== "function") {
      return;
    }
    if (highestCompletedUpdateId === null) {
      return;
    }
    let safe = highestCompletedUpdateId;
    if (pendingUpdateIds.size > 0) {
      let minPending: number | null = null;
      for (const id of pendingUpdateIds) {
        if (minPending === null || id < minPending) {
          minPending = id;
        }
      }
      if (minPending !== null) {
        safe = Math.min(safe, minPending - 1);
      }
    }
    if (highestPersistedUpdateId !== null && safe <= highestPersistedUpdateId) {
      return;
    }
    highestPersistedUpdateId = safe;
    void params.onUpdateId(safe);
  };

  const markCompleted = (updateId: number) => {
    pendingUpdateIds.delete(updateId);
    completedWhileDeferred.delete(updateId);
    if (highestCompletedUpdateId === null || updateId > highestCompletedUpdateId) {
      highestCompletedUpdateId = updateId;
    }
    maybePersistSafeWatermark();
  };

  const beginUpdate = (updateId: number | null | undefined) => {
    if (typeof updateId !== "number") {
      return;
    }
    pendingUpdateIds.add(updateId);
  };

  const endUpdate = (updateId: number | null | undefined) => {
    if (typeof updateId !== "number") {
      return;
    }
    if ((deferredHoldCounts.get(updateId) ?? 0) > 0) {
      completedWhileDeferred.add(updateId);
      return;
    }
    markCompleted(updateId);
  };

  const holdDeferredUpdate = (updateId: number | null | undefined) => {
    if (typeof updateId !== "number") {
      return;
    }
    pendingUpdateIds.add(updateId);
    deferredHoldCounts.set(updateId, (deferredHoldCounts.get(updateId) ?? 0) + 1);
  };

  const releaseDeferredUpdate = (updateId: number | null | undefined) => {
    if (typeof updateId !== "number") {
      return;
    }
    const currentCount = deferredHoldCounts.get(updateId);
    if (!currentCount) {
      return;
    }
    if (currentCount > 1) {
      deferredHoldCounts.set(updateId, currentCount - 1);
      return;
    }
    deferredHoldCounts.delete(updateId);
    if (completedWhileDeferred.has(updateId)) {
      markCompleted(updateId);
    }
  };

  const shouldSkipUpdate = (ctx: TelegramUpdateKeyContext) => {
    const updateId = resolveTelegramUpdateId(ctx);
    const skipCutoff = highestPersistedUpdateId ?? initialUpdateId;
    if (typeof updateId === "number" && skipCutoff !== null && updateId <= skipCutoff) {
      return true;
    }
    const key = buildTelegramUpdateKey(ctx);
    const skipped = recentUpdates.check(key);
    return skipped;
  };

  return {
    beginUpdate,
    endUpdate,
    holdDeferredUpdate,
    releaseDeferredUpdate,
    shouldSkipUpdate,
  };
}

export { MEDIA_GROUP_TIMEOUT_MS };
