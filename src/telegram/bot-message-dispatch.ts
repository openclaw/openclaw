import type { Bot } from "grammy";
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
import type { OpenClawConfig, ReplyToMode, TelegramAccountConfig } from "../config/types.js";
import { danger, logVerbose } from "../globals.js";
import { getAgentScopedMediaLocalRoots } from "../media/local-roots.js";
import type { RuntimeEnv } from "../runtime.js";
import type { TelegramMessageContext } from "./bot-message-context.js";
import type { TelegramBotOptions } from "./bot.js";
import { deliverReplies } from "./bot/delivery.js";
import type { TelegramStreamMode } from "./bot/types.js";
import type { TelegramInlineButtons } from "./button-types.js";
import { resolveTelegramDraftStreamingChunking } from "./draft-chunking.js";
import { createTelegramDraftStream } from "./draft-stream.js";
import { renderTelegramHtmlText } from "./format.js";
import { editMessageTelegram } from "./send.js";
import { cacheSticker, describeStickerImage } from "./sticker-cache.js";

const EMPTY_RESPONSE_FALLBACK = "No response generated. Please try again.";

/** Minimum chars before sending first streaming message (improves push notification UX) */
const DRAFT_MIN_INITIAL_CHARS = 30;
const REASONING_MESSAGE_PREFIX = "Reasoning:\n";

function isReasoningMessage(text?: string): boolean {
  if (typeof text !== "string") {
    return false;
  }
  const trimmed = text.trim();
  return (
    trimmed.startsWith(REASONING_MESSAGE_PREFIX) && trimmed.length > REASONING_MESSAGE_PREFIX.length
  );
}

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
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "telegram",
    accountId: route.accountId,
  });
  const renderDraftPreview = (text: string) => ({
    text: renderTelegramHtmlText(text, { tableMode }),
    parseMode: "HTML" as const,
  });
  const accountBlockStreamingEnabled =
    typeof telegramCfg.blockStreaming === "boolean"
      ? telegramCfg.blockStreaming
      : cfg.agents?.defaults?.blockStreamingDefault === "on";
  const canStreamDraft = streamMode !== "off" && !accountBlockStreamingEnabled;
  const draftReplyToMessageId =
    replyToMode !== "off" && typeof msg.message_id === "number" ? msg.message_id : undefined;
  const draftMinInitialChars = streamMode === "partial" ? 1 : DRAFT_MIN_INITIAL_CHARS;
  const answerDraftStream = canStreamDraft
    ? createTelegramDraftStream({
        api: bot.api,
        chatId,
        maxChars: draftMaxChars,
        thread: threadSpec,
        replyToMessageId: draftReplyToMessageId,
        minInitialChars: draftMinInitialChars,
        renderText: renderDraftPreview,
        log: logVerbose,
        warn: logVerbose,
      })
    : undefined;
  const reasoningDraftStream = canStreamDraft
    ? createTelegramDraftStream({
        api: bot.api,
        chatId,
        maxChars: draftMaxChars,
        thread: threadSpec,
        replyToMessageId: draftReplyToMessageId,
        minInitialChars: draftMinInitialChars,
        renderText: renderDraftPreview,
        log: logVerbose,
        warn: logVerbose,
      })
    : undefined;
  const answerDraftChunking =
    answerDraftStream && streamMode === "block"
      ? resolveTelegramDraftStreamingChunking(cfg, route.accountId)
      : undefined;
  const answerDraftChunker = answerDraftChunking
    ? new EmbeddedBlockChunker(answerDraftChunking)
    : undefined;
  const reasoningDraftChunking =
    reasoningDraftStream && streamMode === "block"
      ? resolveTelegramDraftStreamingChunking(cfg, route.accountId)
      : undefined;
  const reasoningDraftChunker = reasoningDraftChunking
    ? new EmbeddedBlockChunker(reasoningDraftChunking)
    : undefined;
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, route.agentId);
  type DraftLaneState = {
    stream: ReturnType<typeof createTelegramDraftStream> | undefined;
    lastPartialText: string;
    draftText: string;
    hasStreamedMessage: boolean;
    chunker: EmbeddedBlockChunker | undefined;
  };
  const answerLane: DraftLaneState = {
    stream: answerDraftStream,
    lastPartialText: "",
    draftText: "",
    hasStreamedMessage: false,
    chunker: answerDraftChunker,
  };
  const reasoningLane: DraftLaneState = {
    stream: reasoningDraftStream,
    lastPartialText: "",
    draftText: "",
    hasStreamedMessage: false,
    chunker: reasoningDraftChunker,
  };
  let splitReasoningOnNextStream = false;
  const resetDraftLaneState = (lane: DraftLaneState) => {
    lane.lastPartialText = "";
    lane.draftText = "";
    lane.hasStreamedMessage = false;
    lane.chunker?.reset();
  };
  const updateDraftFromPartial = (lane: DraftLaneState, text: string | undefined) => {
    const laneStream = lane.stream;
    if (!laneStream || !text) {
      return;
    }
    if (text === lane.lastPartialText) {
      return;
    }
    // Mark that we've received streaming content (for forceNewMessage decision).
    lane.hasStreamedMessage = true;
    if (streamMode === "partial") {
      // Some providers briefly emit a shorter prefix snapshot (for example
      // "Sure." -> "Sure" -> "Sure."). Keep the longer preview to avoid
      // visible punctuation flicker.
      if (
        lane.lastPartialText &&
        lane.lastPartialText.startsWith(text) &&
        text.length < lane.lastPartialText.length
      ) {
        return;
      }
      lane.lastPartialText = text;
      laneStream.update(text);
      return;
    }
    let delta = text;
    if (text.startsWith(lane.lastPartialText)) {
      delta = text.slice(lane.lastPartialText.length);
    } else {
      // Streaming buffer reset (or non-monotonic stream). Start fresh.
      lane.chunker?.reset();
      lane.draftText = "";
    }
    lane.lastPartialText = text;
    if (!delta) {
      return;
    }
    if (!lane.chunker) {
      lane.draftText = text;
      laneStream.update(lane.draftText);
      return;
    }
    lane.chunker.append(delta);
    lane.chunker.drain({
      force: false,
      emit: (chunk) => {
        lane.draftText += chunk;
        laneStream.update(lane.draftText);
      },
    });
  };
  const flushDraftLane = async (lane: DraftLaneState) => {
    if (!lane.stream) {
      return;
    }
    if (lane.chunker?.hasBuffered()) {
      lane.chunker.drain({
        force: true,
        emit: (chunk) => {
          lane.draftText += chunk;
        },
      });
      lane.chunker.reset();
      if (lane.draftText) {
        lane.stream.update(lane.draftText);
      }
    }
    await lane.stream.flush();
  };

  const disableBlockStreaming =
    typeof telegramCfg.blockStreaming === "boolean"
      ? !telegramCfg.blockStreaming
      : answerDraftStream || streamMode === "off"
        ? true
        : undefined;

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: route.agentId,
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
  const tryFinalizePreviewForLane = async (params: {
    lane: DraftLaneState;
    laneName: "answer" | "reasoning";
    finalText: string;
    previewButtons?: TelegramInlineButtons;
  }): Promise<boolean> => {
    const { lane, laneName, finalText, previewButtons } = params;
    if (!lane.stream) {
      return false;
    }
    const hadPreviewMessage = typeof lane.stream.messageId() === "number";
    const currentPreviewText = streamMode === "block" ? lane.draftText : lane.lastPartialText;
    await lane.stream.stop();
    const previewMessageId = lane.stream.messageId();
    if (typeof previewMessageId !== "number") {
      return false;
    }
    if (
      hadPreviewMessage &&
      currentPreviewText &&
      currentPreviewText.startsWith(finalText) &&
      finalText.length < currentPreviewText.length
    ) {
      // Avoid regressive punctuation/wording flicker from occasional shorter finals.
      deliveryState.delivered = true;
      return true;
    }
    try {
      await editMessageTelegram(chatId, previewMessageId, finalText, {
        api: bot.api,
        cfg,
        accountId: route.accountId,
        linkPreview: telegramCfg.linkPreview,
        buttons: previewButtons,
      });
      deliveryState.delivered = true;
      return true;
    } catch (err) {
      logVerbose(
        `telegram: ${laneName} preview final edit failed; falling back to standard send (${String(err)})`,
      );
      return false;
    }
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
            await flushDraftLane(answerLane);
            await flushDraftLane(reasoningLane);
            const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
            const finalText = payload.text;
            const reasoningMessage = isReasoningMessage(finalText);
            const previewButtons = (
              payload.channelData?.telegram as { buttons?: TelegramInlineButtons } | undefined
            )?.buttons;
            const canFinalizeViaPreviewEdit =
              !hasMedia &&
              typeof finalText === "string" &&
              finalText.length > 0 &&
              finalText.length <= draftMaxChars &&
              !payload.isError;
            if (canFinalizeViaPreviewEdit && reasoningMessage) {
              const finalizedReasoning = await tryFinalizePreviewForLane({
                lane: reasoningLane,
                laneName: "reasoning",
                finalText,
                previewButtons,
              });
              if (finalizedReasoning) {
                return;
              }
            }
            if (canFinalizeViaPreviewEdit && !reasoningMessage && !finalizedViaPreviewMessage) {
              const finalizedAnswer = await tryFinalizePreviewForLane({
                lane: answerLane,
                laneName: "answer",
                finalText,
                previewButtons,
              });
              if (finalizedAnswer) {
                finalizedViaPreviewMessage = true;
                return;
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
            await answerLane.stream?.stop();
            await reasoningLane.stream?.stop();
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
        onPartialReply: answerLane.stream
          ? (payload) => updateDraftFromPartial(answerLane, payload.text)
          : undefined,
        onReasoningStream: reasoningLane.stream
          ? (payload) => {
              // Split between reasoning blocks only when the next reasoning
              // stream starts. Splitting at reasoning-end can orphan the active
              // preview and cause duplicate reasoning sends on reasoning final.
              if (splitReasoningOnNextStream) {
                reasoningLane.stream?.forceNewMessage();
                resetDraftLaneState(reasoningLane);
                splitReasoningOnNextStream = false;
              }
              updateDraftFromPartial(reasoningLane, payload.text);
            }
          : undefined,
        onAssistantMessageStart: answerLane.stream
          ? () => {
              // Keep answer blocks separated in block mode; partial mode keeps one answer lane.
              if (streamMode === "block" && answerLane.hasStreamedMessage) {
                answerLane.stream?.forceNewMessage();
              }
              resetDraftLaneState(answerLane);
            }
          : undefined,
        onReasoningEnd: reasoningLane.stream
          ? () => {
              // Split when/if a later reasoning block begins.
              splitReasoningOnNextStream = reasoningLane.hasStreamedMessage;
            }
          : undefined,
        onModelSelected,
      },
    }));
  } finally {
    // Must stop() first to flush debounced content before clear() wipes state
    await answerLane.stream?.stop();
    if (!finalizedViaPreviewMessage) {
      await answerLane.stream?.clear();
    }
    await reasoningLane.stream?.stop();
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
