import type { ReplyToMode } from "../config/config.js";
import type { TelegramAccountConfig } from "../config/types.telegram.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  buildTelegramMessageContext,
  type BuildTelegramMessageContextParams,
  type TelegramMediaRef,
} from "./bot-message-context.js";
import { dispatchTelegramMessage } from "./bot-message-dispatch.js";
import type { TelegramBotOptions } from "./bot.js";
import type { TelegramContext, TelegramStreamMode } from "./bot/types.js";

/** Dependencies injected once when creating the message processor. */
type TelegramMessageProcessorDeps = Omit<
  BuildTelegramMessageContextParams,
  "primaryCtx" | "allMedia" | "storeAllowFrom" | "options"
> & {
  telegramCfg: TelegramAccountConfig;
  runtime: RuntimeEnv;
  replyToMode: ReplyToMode;
  streamMode: TelegramStreamMode;
  textLimit: number;
  opts: Pick<TelegramBotOptions, "token">;
};

const TELEGRAM_REPLY_BURST_BASE_WINDOW_MS = 10_000;
const TELEGRAM_REPLY_BURST_DENSE_WINDOW_MS = 20_000;
const TELEGRAM_REPLY_BURST_VERY_DENSE_WINDOW_MS = 25_000;
const TELEGRAM_REPLY_BURST_DENSE_MIN_SHORT_COUNT = 2;
const TELEGRAM_REPLY_BURST_VERY_DENSE_MIN_SHORT_COUNT = 4;
const TELEGRAM_SHORT_MESSAGE_MAX_CHARS = 48;

type ReplyBurstState = {
  lastInboundAt: number;
  streak: number;
  recentShortMessageAt: number[];
};

function sweepExpiredReplyBurstState(params: {
  now: number;
  burstState: Map<string, ReplyBurstState>;
}) {
  for (const [key, state] of params.burstState) {
    if (params.now - state.lastInboundAt > TELEGRAM_REPLY_BURST_VERY_DENSE_WINDOW_MS) {
      params.burstState.delete(key);
    }
  }
}

function buildReplyBurstKey(ctx: TelegramContext): string {
  const msg = ctx.message;
  const chatId = String(msg.chat.id);
  const chatType = msg.chat.type;
  const senderScope =
    chatType === "group" || chatType === "supergroup"
      ? "chat"
      : msg.from?.id != null
        ? String(msg.from.id)
        : "unknown";
  const threadId =
    typeof (msg as { message_thread_id?: number }).message_thread_id === "number"
      ? String((msg as { message_thread_id?: number }).message_thread_id)
      : "none";
  return `${chatId}:${senderScope}:${threadId}`;
}

function resolveMessageTextLength(ctx: TelegramContext): number {
  const msg = ctx.message as { text?: string; caption?: string };
  const text = (msg.text ?? msg.caption ?? "").trim();
  return text.length;
}

function resolveAdaptiveReplyToMode(params: {
  configuredMode: ReplyToMode;
  burstState: Map<string, ReplyBurstState>;
  ctx: TelegramContext;
  now?: number;
}): ReplyToMode {
  if (params.configuredMode === "off") {
    return "off";
  }
  const now = params.now ?? Date.now();
  const key = buildReplyBurstKey(params.ctx);
  const previous = params.burstState.get(key);

  const messageTextLength = resolveMessageTextLength(params.ctx);
  const shortMessage =
    messageTextLength > 0 && messageTextLength <= TELEGRAM_SHORT_MESSAGE_MAX_CHARS;
  const recentShortMessageAt = (previous?.recentShortMessageAt ?? []).filter(
    (ts) => now - ts <= TELEGRAM_REPLY_BURST_VERY_DENSE_WINDOW_MS,
  );
  if (shortMessage) {
    recentShortMessageAt.push(now);
  }

  const shortCount = recentShortMessageAt.length;
  const burstWindowMs =
    shortCount >= TELEGRAM_REPLY_BURST_VERY_DENSE_MIN_SHORT_COUNT
      ? TELEGRAM_REPLY_BURST_VERY_DENSE_WINDOW_MS
      : shortCount >= TELEGRAM_REPLY_BURST_DENSE_MIN_SHORT_COUNT
        ? TELEGRAM_REPLY_BURST_DENSE_WINDOW_MS
        : TELEGRAM_REPLY_BURST_BASE_WINDOW_MS;

  const withinBurst = previous != null && now - previous.lastInboundAt <= burstWindowMs;
  const streak = withinBurst ? previous.streak + 1 : 1;
  params.burstState.set(key, { lastInboundAt: now, streak, recentShortMessageAt });
  sweepExpiredReplyBurstState({ now, burstState: params.burstState });
  return streak >= 2 ? params.configuredMode : "off";
}

export const createTelegramMessageProcessor = (deps: TelegramMessageProcessorDeps) => {
  const {
    bot,
    cfg,
    account,
    telegramCfg,
    historyLimit,
    groupHistories,
    dmPolicy,
    allowFrom,
    groupAllowFrom,
    ackReactionScope,
    logger,
    resolveGroupActivation,
    resolveGroupRequireMention,
    resolveTelegramGroupConfig,
    sendChatActionHandler,
    runtime,
    replyToMode,
    streamMode,
    textLimit,
    opts,
  } = deps;

  const replyBurstState = new Map<string, ReplyBurstState>();

  return async (
    primaryCtx: TelegramContext,
    allMedia: TelegramMediaRef[],
    storeAllowFrom: string[],
    options?: { messageIdOverride?: string; forceWasMentioned?: boolean },
    replyMedia?: TelegramMediaRef[],
  ) => {
    const context = await buildTelegramMessageContext({
      primaryCtx,
      allMedia,
      replyMedia,
      storeAllowFrom,
      options,
      bot,
      cfg,
      account,
      historyLimit,
      groupHistories,
      dmPolicy,
      allowFrom,
      groupAllowFrom,
      ackReactionScope,
      logger,
      resolveGroupActivation,
      resolveGroupRequireMention,
      resolveTelegramGroupConfig,
      sendChatActionHandler,
    });
    if (!context) {
      return;
    }
    const effectiveReplyToMode = resolveAdaptiveReplyToMode({
      configuredMode: replyToMode,
      burstState: replyBurstState,
      ctx: primaryCtx,
    });

    await dispatchTelegramMessage({
      context,
      bot,
      cfg,
      runtime,
      replyToMode: effectiveReplyToMode,
      streamMode,
      textLimit,
      telegramCfg,
      opts,
    });
  };
};
