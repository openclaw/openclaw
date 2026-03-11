import type { ReplyToMode } from "../config/config.js";
import type { TelegramAccountConfig } from "../config/types.telegram.js";
import { danger } from "../globals.js";
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
  const processingIndicator = telegramCfg.processingIndicator?.trim();

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
    let processingIndicatorMessageId: number | undefined;
    if (processingIndicator) {
      try {
        const sent = await bot.api.sendMessage(
          context.chatId,
          processingIndicator,
          context.threadSpec?.id != null ? { message_thread_id: context.threadSpec.id } : undefined,
        );
        processingIndicatorMessageId = sent?.message_id;
      } catch {
        // Best-effort UX only; continue processing if the indicator cannot be sent.
      }
    }
    try {
      await dispatchTelegramMessage({
        context,
        bot,
        cfg,
        runtime,
        replyToMode,
        streamMode,
        textLimit,
        telegramCfg,
        opts,
      });
      if (processingIndicatorMessageId != null) {
        try {
          await bot.api.deleteMessage(context.chatId, processingIndicatorMessageId);
        } catch {
          // Best-effort cleanup only.
        }
      }
    } catch (err) {
      runtime.error?.(danger(`telegram message processing failed: ${String(err)}`));
      if (processingIndicatorMessageId != null) {
        try {
          await bot.api.editMessageText(
            context.chatId,
            processingIndicatorMessageId,
            "Something went wrong while processing your request. Please try again.",
          );
          return;
        } catch {
          // Fall back to a new message if the indicator cannot be edited.
        }
      }
      try {
        await bot.api.sendMessage(
          context.chatId,
          "Something went wrong while processing your request. Please try again.",
          context.threadSpec?.id != null ? { message_thread_id: context.threadSpec.id } : undefined,
        );
      } catch {
        // Best-effort fallback; delivery may fail if the bot was blocked or the chat is invalid.
      }
    }
  };
};
