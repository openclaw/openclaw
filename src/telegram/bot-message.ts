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

const TELEGRAM_REPLY_BURST_WINDOW_MS = 60_000;

type ReplyBurstState = {
  lastInboundAt: number;
  streak: number;
};

function buildReplyBurstKey(ctx: TelegramContext): string {
  const msg = ctx.message;
  const chatId = String(msg.chat.id);
  const senderId = msg.from?.id != null ? String(msg.from.id) : "unknown";
  const threadId =
    typeof (msg as { message_thread_id?: number }).message_thread_id === "number"
      ? String((msg as { message_thread_id?: number }).message_thread_id)
      : "none";
  return `${chatId}:${senderId}:${threadId}`;
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
  const withinBurst =
    previous != null && now - previous.lastInboundAt <= TELEGRAM_REPLY_BURST_WINDOW_MS;
  const streak = withinBurst ? previous.streak + 1 : 1;
  params.burstState.set(key, { lastInboundAt: now, streak });
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
