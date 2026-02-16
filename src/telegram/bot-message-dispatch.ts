import type { Bot } from "grammy";
import type { OpenClawConfig, ReplyToMode, TelegramAccountConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import type { TelegramMessageContext } from "./bot-message-context.js";
import type { TelegramBotOptions } from "./bot.js";
import type { TelegramStreamMode } from "./bot/types.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import {
  findModelInCatalog,
  loadModelCatalog,
  modelSupportsVision,
} from "../agents/model-catalog.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { EmbeddedBlockChunker } from "../agents/pi-embedded-block-chunker.js";
import { resolveChunkMode } from "../auto-reply/chunk.js";
import { clearHistoryEntriesIfEnabled } from "../auto-reply/reply/history.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.js";
import { removeAckReactionAfterReply } from "../channels/ack-reactions.js";
import { logAckFailure, logTypingFailure } from "../channels/logging.js";
import { createReplyPrefixOptions } from "../channels/reply-prefix.js";
import { createTypingCallbacks } from "../channels/typing.js";
import { resolveMarkdownTableMode } from "../config/markdown-tables.js";
import { danger, logVerbose } from "../globals.js";
import { getAgentScopedMediaLocalRoots } from "../media/local-roots.js";
import { deliverReplies } from "./bot/delivery.js";
import { resolveTelegramDraftStreamingChunking } from "./draft-chunking.js";
import { createTelegramDraftStream } from "./draft-stream.js";
import { editMessageTelegram } from "./send.js";
import { cacheSticker, describeStickerImage } from "./sticker-cache.js";

const EMPTY_RESPONSE_FALLBACK = "No response generated. Please try again.";

async function resolveStickerVisionSupport(cfg: OpenClawConfig, agentId: string) {
  try {
    const catalog = await loadModelCatalog({ config: cfg });
    const defaultModel = resolveDefaultModelForAgent({ cfg, agentId });
    const entry = findModelInCatalog(catalog, defaultModel.provider, defaultModel.model);
    if (!entry) {
      return false;
    }
    return modelSupportsVision(entry);
  } catch {
    return false;
  }
}

type DispatchTelegramMessageParams = {
  context: TelegramMessageContext;
  bot: Bot;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  replyToMode: ReplyToMode;
  streamMode: TelegramStreamMode;
  textLimit: number;
  telegramCfg: TelegramAccountConfig;
  opts: Pick<TelegramBotOptions, "token">;
};

export const dispatchTelegramMessage = async ({
  context,
  bot,
  cfg,
  runtime,
  replyToMode,
  streamMode,
  textLimit,
  telegramCfg,
  opts,
}: DispatchTelegramMessageParams) => {
  const {
    ctxPayload,
    msg,
    chatId,
    isGroup,
    threadSpec,
    historyKey,
    historyLimit,
    groupHistories,
    route,
    skillFilter,
    sendTyping,
    sendRecordVoice,
    ackReactionPromise,
    reactionApi,
    removeAckAfterReply,
  } = context;

  const draftMaxChars = Math.min(textLimit, 4096);
  const accountBlockStreamingEnabled =
    typeof telegramCfg.blockStreaming === "boolean"
      ? telegramCfg.blockStreaming
      : cfg.agents?.defaults?.blockStreamingDefault === "on";
  const canStreamDraft = streamMode !== "off" && !accountBlockStreamingEnabled;
  const draftReplyToMessageId =
    replyToMode !== "off" && typeof msg.message_id === "number" ? msg.message_id : undefined;
  const draftStream = canStreamDraft
    ? createTelegramDraftStream({
        api: bot.api,
        chatId,
        maxChars: draftMaxChars,
        thread: threadSpec,
        replyToMessageId: draftReplyToMessageId,
        log: logVerbose,
        warn: logVerbose,
      })
    : undefined;
  const draftChunking =
    draftStream && streamMode === "block"
      ? resolveTelegramDraftStreamingChunking(cfg, route.accountId)
      : undefined;
  const draftChunker = draftChunking ? new EmbeddedBlockChunker(draftChunking) : undefined;
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, route.agentId);
  let lastPartialText = "";
  let draftText = "";
  let hasStreamedMessage = false;
  const updateDraftFromPartial = (text?: string) => {
    if (!draftStream || !text) {
      return;
    }
    if (text === lastPartialText) {
      return;
    }
    // Mark that we've received streaming content (for forceNewMessage decision).
    hasStreamedMessage = true;
    if (streamMode === "partial") {
      // Some providers briefly emit a shorter prefix snapshot (for example
      // "Sure." -> "Sure" -> "Sure."). Keep the longer preview to avoid
      // visible punctuation flicker.
      if (
        lastPartialText &&
        lastPartialText.startsWith(text) &&
        text.length < lastPartialText.length
      ) {
        return;
      }
      lastPartialText = text;
      draftStream.update(text);
      return;
    }
    let delta = text;
    if (text.startsWith(lastPartialText)) {
      delta = text.slice(lastPartialText.length);
    } else {
      // Streaming buffer reset (or non-monotonic stream). Start fresh.
      draftChunker?.reset();
      draftText = "";
    }
    lastPartialText = text;
    if (!delta) {
      return;
    }
    if (!draftChunker) {
      draftText = text;
      draftStream.update(draftText);
      return;
    }
    draftChunker.append(delta);
    draftChunker.drain({
      force: false,
      emit: (chunk) => {
        draftText += chunk;
        draftStream.update(draftText);
      },
    });
  };
  const flushDraft = async () => {
    if (!draftStream) {
      return;
    }
    if (draftChunker?.hasBuffered()) {
      draftChunker.drain({
        force: true,
        emit: (chunk) => {
          draftText += chunk;
        },
      });
      draftChunker.reset();
      if (draftText) {
        draftStream.update(draftText);
      }
    }
    await draftStream.flush();
  };

  const disableBlockStreaming =
    typeof telegramCfg.blockStreaming === "boolean"
      ? !telegramCfg.blockStreaming
      : draftStream || streamMode === "off"
        ? true
        : undefined;

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: route.agentId,
    channel: "telegram",
    accountId: route.accountId,
  });
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "telegram",
    accountId: route.accountId,
  });
  const chunkMode = resolveChunkMode(cfg, "telegram", route.accountId);

  // Handle uncached stickers: get a dedicated vision description before dispatch
  // This ensures we cache a raw description rather than a conversational response
  const sticker = ctxPayload.Sticker;
  if (sticker?.fileId && sticker.fileUniqueId && ctxPayload.MediaPath) {
    const agentDir = resolveAgentDir(cfg, route.agentId);
    const stickerSupportsVision = await resolveStickerVisionSupport(cfg, route.agentId);
    let description = sticker.cachedDescription ?? null;
    if (!description) {
      description = await describeStickerImage({
        imagePath: ctxPayload.MediaPath,
        cfg,
        agentDir,
        agentId: route.agentId,
      });
    }
    if (description) {
      // Format the description with sticker context
      const stickerContext = [sticker.emoji, sticker.setName ? `from "${sticker.setName}"` : null]
        .filter(Boolean)
        .join(" ");
      const formattedDesc = `[Sticker${stickerContext ? ` ${stickerContext}` : ""}] ${description}`;

      sticker.cachedDescription = description;
      if (!stickerSupportsVision) {
        // Update context to use description instead of image
        ctxPayload.Body = formattedDesc;
        ctxPayload.BodyForAgent = formattedDesc;
        // Clear media paths so native vision doesn't process the image again
        ctxPayload.MediaPath = undefined;
        ctxPayload.MediaType = undefined;
        ctxPayload.MediaUrl = undefined;
        ctxPayload.MediaPaths = undefined;
        ctxPayload.MediaUrls = undefined;
        ctxPayload.MediaTypes = undefined;
      }

      // Cache the description for future encounters
      if (sticker.fileId) {
        cacheSticker({
          fileId: sticker.fileId,
          fileUniqueId: sticker.fileUniqueId,
          emoji: sticker.emoji,
          setName: sticker.setName,
          description,
          cachedAt: new Date().toISOString(),
          receivedFrom: ctxPayload.From,
        });
        logVerbose(`telegram: cached sticker description for ${sticker.fileUniqueId}`);
      } else {
        logVerbose(`telegram: skipped sticker cache (missing fileId)`);
      }
    }
  }

  const replyQuoteText =
    ctxPayload.ReplyToIsQuote && ctxPayload.ReplyToBody
      ? ctxPayload.ReplyToBody.trim() || undefined
      : undefined;
  const deliveryState = {
    delivered: false,
    skippedNonSilent: 0,
  };
  let finalizedViaPreviewMessage = false;
  const clearGroupHistory = () => {
    if (isGroup && historyKey) {
      clearHistoryEntriesIfEnabled({ historyMap: groupHistories, historyKey, limit: historyLimit });
    }
  };
  const deliveryBaseOptions = {
    chatId: String(chatId),
    token: opts.token,
    runtime,
    bot,
    mediaLocalRoots,
    replyToMode,
    textLimit,
    thread: threadSpec,
    tableMode,
    chunkMode,
    linkPreview: telegramCfg.linkPreview,
    replyQuoteText,
  };

  let queuedFinal = false;
  try {
    ({ queuedFinal } = await dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        ...prefixOptions,
        deliver: async (payload, info) => {
          if (info.kind === "final") {
            await flushDraft();
            const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
            const previewMessageId = draftStream?.messageId();
            const finalText = payload.text;
            const currentPreviewText = streamMode === "block" ? draftText : lastPartialText;
            const previewButtons = (
              payload.channelData?.telegram as
                | { buttons?: Array<Array<{ text: string; callback_data: string }>> }
                | undefined
            )?.buttons;
            let draftStoppedForPreviewEdit = false;
            // Skip preview edit for error payloads to avoid overwriting previous content
            const canFinalizeViaPreviewEdit =
              !finalizedViaPreviewMessage &&
              !hasMedia &&
              typeof finalText === "string" &&
              finalText.length > 0 &&
              typeof previewMessageId === "number" &&
              finalText.length <= draftMaxChars &&
              !payload.isError;
            if (canFinalizeViaPreviewEdit) {
              draftStream?.stop();
              draftStoppedForPreviewEdit = true;
              if (
                currentPreviewText &&
                currentPreviewText.startsWith(finalText) &&
                finalText.length < currentPreviewText.length
              ) {
                // Ignore regressive final edits (e.g., "Okay." -> "Ok"), which
                // can appear transiently in some provider streams.
                return;
              }
              try {
                await editMessageTelegram(chatId, previewMessageId, finalText, {
                  api: bot.api,
                  cfg,
                  accountId: route.accountId,
                  linkPreview: telegramCfg.linkPreview,
                  buttons: previewButtons,
                });
                finalizedViaPreviewMessage = true;
                deliveryState.delivered = true;
                return;
              } catch (err) {
                logVerbose(
                  `telegram: preview final edit failed; falling back to standard send (${String(err)})`,
                );
              }
            }
            if (
              !hasMedia &&
              !payload.isError &&
              typeof finalText === "string" &&
              finalText.length > draftMaxChars
            ) {
              logVerbose(
                `telegram: preview final too long for edit (${finalText.length} > ${draftMaxChars}); falling back to standard send`,
              );
            }
            if (!draftStoppedForPreviewEdit) {
              draftStream?.stop();
            }
          }
          const result = await deliverReplies({
            ...deliveryBaseOptions,
            replies: [payload],
            onVoiceRecording: sendRecordVoice,
          });
          if (result.delivered) {
            deliveryState.delivered = true;
          }
        },
        onSkip: (_payload, info) => {
          if (info.reason !== "silent") {
            deliveryState.skippedNonSilent += 1;
          }
        },
        onError: (err, info) => {
          runtime.error?.(danger(`telegram ${info.kind} reply failed: ${String(err)}`));
        },
        onReplyStart: createTypingCallbacks({
          start: sendTyping,
          onStartError: (err) => {
            logTypingFailure({
              log: logVerbose,
              channel: "telegram",
              target: String(chatId),
              error: err,
            });
          },
        }).onReplyStart,
      },
      replyOptions: {
        skillFilter,
        disableBlockStreaming,
        onPartialReply: draftStream ? (payload) => updateDraftFromPartial(payload.text) : undefined,
        onAssistantMessageStart: draftStream
          ? () => {
              // When a new assistant message starts (e.g., after tool call),
              // force a new Telegram message if we have previous content.
              // Only force once per response to avoid excessive splitting.
              logVerbose(
                `telegram: onAssistantMessageStart called, hasStreamedMessage=${hasStreamedMessage}`,
              );
              if (hasStreamedMessage) {
                logVerbose(`telegram: calling forceNewMessage()`);
                draftStream.forceNewMessage();
              }
              lastPartialText = "";
              draftText = "";
              draftChunker?.reset();
            }
          : undefined,
        onReasoningEnd: draftStream
          ? () => {
              // When a thinking block ends, force a new Telegram message for the next text output.
              if (hasStreamedMessage) {
                draftStream.forceNewMessage();
                lastPartialText = "";
                draftText = "";
                draftChunker?.reset();
              }
            }
          : undefined,
        onModelSelected,
      },
    }));
  } finally {
    if (!finalizedViaPreviewMessage) {
      await draftStream?.clear();
    }
    draftStream?.stop();
  }
  let sentFallback = false;
  if (!deliveryState.delivered && deliveryState.skippedNonSilent > 0) {
    const result = await deliverReplies({
      replies: [{ text: EMPTY_RESPONSE_FALLBACK }],
      ...deliveryBaseOptions,
    });
    sentFallback = result.delivered;
  }

  const hasFinalResponse = queuedFinal || sentFallback;
  if (!hasFinalResponse) {
    clearGroupHistory();
    return;
  }
  removeAckReactionAfterReply({
    removeAfterReply: removeAckAfterReply,
    ackReactionPromise,
    ackReactionValue: ackReactionPromise ? "ack" : null,
    remove: () => reactionApi?.(chatId, msg.message_id ?? 0, []) ?? Promise.resolve(),
    onError: (err) => {
      if (!msg.message_id) {
        return;
      }
      logAckFailure({
        log: logVerbose,
        channel: "telegram",
        target: `${chatId}/${msg.message_id}`,
        error: err,
      });
    },
  });
  clearGroupHistory();
};
