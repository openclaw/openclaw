import type { Bot } from "grammy";
import type { BotConfig, ReplyToMode, TelegramAccountConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import type { TelegramMessageContext } from "./bot-message-context.js";
import type { TelegramBotOptions } from "./bot.js";
import type { TelegramStreamMode } from "./bot/types.js";
import type { TelegramInlineButtons } from "./button-types.js";
import type { TelegramDraftStream } from "./draft-stream.js";
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
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import { danger, logVerbose } from "../globals.js";
import { getAgentScopedMediaLocalRoots } from "../media/local-roots.js";
import { deliverReplies } from "./bot/delivery.js";
import { resolveTelegramDraftStreamingChunking } from "./draft-chunking.js";
import { createTelegramDraftStream } from "./draft-stream.js";
import { editMessageTelegram } from "./send.js";
import { cacheSticker, describeStickerImage } from "./sticker-cache.js";

const EMPTY_RESPONSE_FALLBACK = "No response generated. Please try again.";
const THINK_TAG_REGEX = /^<think>([\s\S]*?)(?:<\/think>|$)([\s\S]*)$/;
const REASONING_PREFIX = "Reasoning:\n";

async function resolveStickerVisionSupport(cfg: BotConfig, agentId: string) {
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

/**
 * Parse think-tag content from a partial or final text.
 * Returns { reasoning, answer } where reasoning is the italic-formatted
 * content inside `<think>...</think>` and answer is everything after.
 */
function parseThinkTags(text: string): { reasoning: string; answer: string } | null {
  const match = THINK_TAG_REGEX.exec(text);
  if (!match) {
    return null;
  }
  const thinkContent = match[1]?.trim() ?? "";
  const answerContent = match[2]?.trim() ?? "";
  return {
    reasoning: thinkContent ? `${REASONING_PREFIX}_${thinkContent}_` : "",
    answer: answerContent,
  };
}

/** Check whether a text payload is reasoning-only (starts with "Reasoning:\n"). */
function isReasoningOnlyPayload(text: string): boolean {
  return text.startsWith(REASONING_PREFIX);
}

export function pruneStickerMediaFromContext(
  ctxPayload: {
    MediaPath?: string;
    MediaUrl?: string;
    MediaType?: string;
    MediaPaths?: string[];
    MediaUrls?: string[];
    MediaTypes?: string[];
  },
  opts?: { stickerMediaIncluded?: boolean },
) {
  if (opts?.stickerMediaIncluded === false) {
    return;
  }
  const nextMediaPaths = Array.isArray(ctxPayload.MediaPaths)
    ? ctxPayload.MediaPaths.slice(1)
    : undefined;
  const nextMediaUrls = Array.isArray(ctxPayload.MediaUrls)
    ? ctxPayload.MediaUrls.slice(1)
    : undefined;
  const nextMediaTypes = Array.isArray(ctxPayload.MediaTypes)
    ? ctxPayload.MediaTypes.slice(1)
    : undefined;
  ctxPayload.MediaPaths = nextMediaPaths && nextMediaPaths.length > 0 ? nextMediaPaths : undefined;
  ctxPayload.MediaUrls = nextMediaUrls && nextMediaUrls.length > 0 ? nextMediaUrls : undefined;
  ctxPayload.MediaTypes = nextMediaTypes && nextMediaTypes.length > 0 ? nextMediaTypes : undefined;
  ctxPayload.MediaPath = ctxPayload.MediaPaths?.[0];
  ctxPayload.MediaUrl = ctxPayload.MediaUrls?.[0] ?? ctxPayload.MediaPath;
  ctxPayload.MediaType = ctxPayload.MediaTypes?.[0];
}

type DispatchTelegramMessageParams = {
  context: TelegramMessageContext;
  bot: Bot;
  cfg: BotConfig;
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

  // --- Session-based reasoning level resolution ---
  const storePath = resolveStorePath();
  const sessionStore = loadSessionStore(storePath, { skipCache: true });
  const sessionKey = (ctxPayload as { SessionKey?: string }).SessionKey;
  const sessionEntry = sessionKey ? sessionStore[sessionKey] : undefined;
  const reasoningLevel = sessionEntry?.reasoningLevel;
  const reasoningStreamEnabled = reasoningLevel === "stream";
  const reasoningBlockEnabled = reasoningLevel === "on";

  const draftMaxChars = Math.min(textLimit, 4096);
  const accountBlockStreamingEnabled =
    typeof telegramCfg.blockStreaming === "boolean"
      ? telegramCfg.blockStreaming
      : cfg.agents?.defaults?.blockStreamingDefault === "on";

  // When reasoning level is "on", keep block streaming enabled (no draft streams).
  const effectiveBlockStreamingEnabled = accountBlockStreamingEnabled || reasoningBlockEnabled;

  // Answer draft stream: only created when streaming is possible and not overridden.
  const canStreamAnswerDraft = streamMode !== "off" && !effectiveBlockStreamingEnabled;

  const draftReplyToMessageId =
    replyToMode !== "off" && typeof msg.message_id === "number" ? msg.message_id : undefined;

  // Track superseded answer preview message IDs for multi-message finalization.
  const supersededAnswerPreviews: Array<{ messageId: number; textSnapshot: string }> = [];

  // --- Create answer draft stream ---
  const answerDraftStream: TelegramDraftStream | undefined = canStreamAnswerDraft
    ? createTelegramDraftStream({
        api: bot.api,
        chatId,
        maxChars: draftMaxChars,
        thread: threadSpec,
        replyToMessageId: draftReplyToMessageId,
        minInitialChars: 30,
        onSupersededPreview: (preview) => {
          supersededAnswerPreviews.push(preview);
        },
        log: logVerbose,
        warn: logVerbose,
      })
    : undefined;

  // --- Create reasoning draft stream ---
  // Always created alongside the answer stream (dual-stream architecture).
  // When reasoning streaming is off, the stream is idle but available.
  // When reasoning streaming is enabled without answer streaming (streamMode=off),
  // only the reasoning stream is created.
  const canStreamReasoningDraft = canStreamAnswerDraft || reasoningStreamEnabled;
  const reasoningDraftStream: TelegramDraftStream | undefined = canStreamReasoningDraft
    ? createTelegramDraftStream({
        api: bot.api,
        chatId,
        maxChars: draftMaxChars,
        thread: threadSpec,
        minInitialChars: 30,
        onSupersededPreview: (preview) => {
          // Clean up superseded reasoning preview messages by deleting them.
          try {
            void bot.api.deleteMessage(chatId, preview.messageId);
          } catch {
            logVerbose(
              `telegram: failed to delete superseded reasoning preview ${preview.messageId}`,
            );
          }
        },
        log: logVerbose,
        warn: logVerbose,
      })
    : undefined;

  // At least one draft stream is active.
  const hasDraftStream = Boolean(answerDraftStream) || Boolean(reasoningDraftStream);

  // Track message boundaries for multi-message preview finalization.
  // Each entry stores the answer preview message ID at the boundary point.
  const previewMessageIdHistory: Array<number | undefined> = [];

  const draftChunking =
    answerDraftStream && streamMode === "block"
      ? resolveTelegramDraftStreamingChunking(cfg, route.accountId)
      : undefined;
  const draftChunker = draftChunking ? new EmbeddedBlockChunker(draftChunking) : undefined;
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, route.agentId);
  let lastPartialText = "";
  let draftText = "";
  let hasStreamedMessage = false;
  let hasStreamedReasoningMessage = false;
  let reasoningEnded = false;

  // Determine disableBlockStreaming.
  let disableBlockStreaming: boolean | undefined;
  if (streamMode === "off") {
    disableBlockStreaming = true;
  } else if (effectiveBlockStreamingEnabled) {
    disableBlockStreaming = false;
  } else if (answerDraftStream) {
    disableBlockStreaming = true;
  } else {
    disableBlockStreaming = undefined;
  }

  const updateAnswerDraftFromPartial = (text: string) => {
    if (!answerDraftStream) {
      return;
    }
    if (text === lastPartialText) {
      return;
    }
    hasStreamedMessage = true;
    if (streamMode === "partial") {
      if (
        lastPartialText &&
        lastPartialText.startsWith(text) &&
        text.length < lastPartialText.length
      ) {
        return;
      }
      lastPartialText = text;
      answerDraftStream.update(text);
      return;
    }
    let delta = text;
    if (text.startsWith(lastPartialText)) {
      delta = text.slice(lastPartialText.length);
    } else {
      draftChunker?.reset();
      draftText = "";
    }
    lastPartialText = text;
    if (!delta) {
      return;
    }
    if (!draftChunker) {
      draftText = text;
      answerDraftStream.update(draftText);
      return;
    }
    draftChunker.append(delta);
    draftChunker.drain({
      force: false,
      emit: (chunk) => {
        draftText += chunk;
        answerDraftStream.update(draftText);
      },
    });
  };

  /**
   * Handle partial reply: split think-tag content into reasoning/answer lanes
   * when reasoning streaming is enabled.
   */
  const updateDraftFromPartial = (text?: string) => {
    if (!text) {
      return;
    }
    if (!hasDraftStream) {
      return;
    }

    if (reasoningStreamEnabled && reasoningDraftStream) {
      const parsed = parseThinkTags(text);
      if (parsed) {
        if (parsed.reasoning) {
          reasoningDraftStream.update(parsed.reasoning);
          hasStreamedReasoningMessage = true;
        }
        if (parsed.answer) {
          updateAnswerDraftFromPartial(parsed.answer);
        }
        return;
      }
    }

    if (answerDraftStream) {
      updateAnswerDraftFromPartial(text);
    }
  };

  const updateReasoningDraft = (text?: string) => {
    if (!reasoningDraftStream || !text) {
      return;
    }
    hasStreamedReasoningMessage = true;
    reasoningDraftStream.update(text);
  };

  const flushDraft = async () => {
    if (!answerDraftStream) {
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
        answerDraftStream.update(draftText);
      }
    }
    await answerDraftStream.flush();
  };

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

  // Handle uncached stickers
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
      const stickerContext = [sticker.emoji, sticker.setName ? `from "${sticker.setName}"` : null]
        .filter(Boolean)
        .join(" ");
      const formattedDesc = `[Sticker${stickerContext ? ` ${stickerContext}` : ""}] ${description}`;

      sticker.cachedDescription = description;
      if (!stickerSupportsVision) {
        ctxPayload.Body = formattedDesc;
        ctxPayload.BodyForAgent = formattedDesc;
        // Drop only the sticker attachment; keep replied media context if present.
        pruneStickerMediaFromContext(ctxPayload, {
          stickerMediaIncluded: ctxPayload.StickerMediaIncluded,
        });
      }

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
    failedDeliveries: 0,
  };
  // Set of answer preview message IDs that have been finalized via edit.
  const finalizedPreviewIds = new Set<number>();
  let finalDeliveryCount = 0;
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

  /**
   * Resolve the preview message ID for the Nth final delivery.
   * Multi-message streams track historical IDs at boundary points.
   */
  const resolvePreviewMessageIdForFinal = (index: number): number | undefined => {
    // First check superseded previews (late-resolved IDs from forceNewMessage rotations).
    if (index < supersededAnswerPreviews.length) {
      return supersededAnswerPreviews[index].messageId;
    }
    // Then check recorded boundary history.
    if (index < previewMessageIdHistory.length) {
      return previewMessageIdHistory[index];
    }
    // Fall back to current active preview.
    return answerDraftStream?.messageId();
  };

  /**
   * Try to edit a reasoning preview message with the given text.
   * Returns true if the edit succeeded.
   */
  const tryEditReasoningPreview = async (text: string): Promise<boolean> => {
    const reasoningMessageId = reasoningDraftStream?.messageId();
    if (typeof reasoningMessageId !== "number") {
      return false;
    }
    try {
      await editMessageTelegram(chatId, reasoningMessageId, text, {
        api: bot.api,
        cfg,
        accountId: route.accountId,
        linkPreview: telegramCfg.linkPreview,
      });
      return true;
    } catch (err) {
      logVerbose(`telegram: reasoning preview edit failed (${String(err)})`);
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
          const finalText = typeof payload.text === "string" ? payload.text : undefined;

          // Route reasoning block payloads to reasoning preview instead of normal delivery.
          if (
            info.kind === "block" &&
            reasoningStreamEnabled &&
            reasoningDraftStream &&
            typeof finalText === "string" &&
            isReasoningOnlyPayload(finalText)
          ) {
            void reasoningDraftStream.stop();
            const edited = await tryEditReasoningPreview(finalText);
            if (edited) {
              deliveryState.delivered = true;
              return;
            }
          }

          if (info.kind === "final") {
            // Check for reasoning-only final payloads.
            if (typeof finalText === "string" && isReasoningOnlyPayload(finalText)) {
              if (reasoningStreamEnabled && reasoningDraftStream) {
                // Edit the reasoning preview with expanded final text.
                void reasoningDraftStream.stop();
                const edited = await tryEditReasoningPreview(finalText);
                if (edited) {
                  deliveryState.delivered = true;
                  finalDeliveryCount += 1;
                  return;
                }
              }
              // Suppress reasoning-only finals when not streaming reasoning.
              finalDeliveryCount += 1;
              return;
            }

            // Handle think-tag finals: split into reasoning and answer lanes.
            if (reasoningStreamEnabled && reasoningDraftStream && typeof finalText === "string") {
              const parsed = parseThinkTags(finalText);
              if (parsed) {
                if (parsed.reasoning) {
                  void reasoningDraftStream.stop();
                  const edited = await tryEditReasoningPreview(parsed.reasoning);
                  if (edited) {
                    deliveryState.delivered = true;
                  }
                }
                if (parsed.answer) {
                  payload = { ...payload, text: parsed.answer };
                } else {
                  finalDeliveryCount += 1;
                  return;
                }
              }
            }

            await flushDraft();
            const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
            let previewMessageId = resolvePreviewMessageIdForFinal(finalDeliveryCount);
            const editFinalText = typeof payload.text === "string" ? payload.text : undefined;
            const currentPreviewText = streamMode === "block" ? draftText : lastPartialText;
            const previewButtons = (
              payload.channelData?.telegram as { buttons?: TelegramInlineButtons } | undefined
            )?.buttons;
            let draftStopped = false;
            // Tracks whether the preview message was newly created by the stop-prime
            // flow (content already visible as the stop-flush message).
            let stopPrimedNewMessage = false;

            // When no preview message exists yet, prime the draft with final text
            // and await stop() to create one (handles minInitialChars debounce case).
            if (
              answerDraftStream &&
              typeof previewMessageId !== "number" &&
              !hasMedia &&
              typeof editFinalText === "string" &&
              editFinalText.length > 0 &&
              editFinalText.length <= draftMaxChars &&
              !payload.isError
            ) {
              answerDraftStream.update(editFinalText);
              await answerDraftStream.stop();
              draftStopped = true;
              stopPrimedNewMessage = true;
              previewMessageId = answerDraftStream.messageId();
            }

            // Skip preview edit for error payloads to avoid overwriting previous content.
            const canFinalizeViaPreviewEdit =
              !hasMedia &&
              typeof editFinalText === "string" &&
              editFinalText.length > 0 &&
              typeof previewMessageId === "number" &&
              !finalizedPreviewIds.has(previewMessageId) &&
              editFinalText.length <= draftMaxChars &&
              !payload.isError;

            if (canFinalizeViaPreviewEdit && typeof previewMessageId === "number") {
              if (!draftStopped) {
                void answerDraftStream?.stop();
                draftStopped = true;
              }
              if (
                currentPreviewText &&
                currentPreviewText.startsWith(editFinalText) &&
                editFinalText.length < currentPreviewText.length
              ) {
                // Ignore regressive final edits (e.g., "Okay." -> "Ok").
                // The preview already shows the longer text; treat as finalized.
                finalizedPreviewIds.add(previewMessageId);
                deliveryState.delivered = true;
                finalDeliveryCount += 1;
                return;
              }
              try {
                await editMessageTelegram(chatId, previewMessageId, editFinalText, {
                  api: bot.api,
                  cfg,
                  accountId: route.accountId,
                  linkPreview: telegramCfg.linkPreview,
                  buttons: previewButtons,
                });
                finalizedPreviewIds.add(previewMessageId);
                deliveryState.delivered = true;
                finalDeliveryCount += 1;
                return;
              } catch (err) {
                // If the preview was created by stop() flush, the content was already
                // sent as the stop-flush message. Don't fall back to a duplicate send.
                if (stopPrimedNewMessage) {
                  logVerbose(
                    `telegram: stop-created preview edit failed (${String(err)}); content already visible`,
                  );
                  finalizedPreviewIds.add(previewMessageId);
                  deliveryState.delivered = true;
                  finalDeliveryCount += 1;
                  return;
                }
                logVerbose(
                  `telegram: preview final edit failed; falling back to standard send (${String(err)})`,
                );
              }
            }
            if (
              !hasMedia &&
              !payload.isError &&
              typeof editFinalText === "string" &&
              editFinalText.length > draftMaxChars
            ) {
              logVerbose(
                `telegram: preview final too long for edit (${editFinalText.length} > ${draftMaxChars}); falling back to standard send`,
              );
            }
            if (!draftStopped) {
              void answerDraftStream?.stop();
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
          if (info.kind === "final") {
            finalDeliveryCount += 1;
          }
        },
        onSkip: (_payload, info) => {
          if (info.reason !== "silent") {
            deliveryState.skippedNonSilent += 1;
          }
        },
        onError: (err, info) => {
          deliveryState.failedDeliveries += 1;
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
        onPartialReply: hasDraftStream
          ? (payload) => updateDraftFromPartial(payload.text)
          : undefined,
        onAssistantMessageStart: answerDraftStream
          ? () => {
              logVerbose(
                `telegram: onAssistantMessageStart called, hasStreamedMessage=${hasStreamedMessage}`,
              );
              if (hasStreamedMessage) {
                // Record the current preview message ID before rotating.
                previewMessageIdHistory.push(answerDraftStream.messageId());
                logVerbose(`telegram: calling forceNewMessage()`);
                answerDraftStream.forceNewMessage();
              }
              lastPartialText = "";
              draftText = "";
              draftChunker?.reset();
            }
          : undefined,
        onReasoningStream:
          reasoningStreamEnabled && reasoningDraftStream
            ? (payload: { text?: string }) => {
                if (reasoningEnded && hasStreamedReasoningMessage) {
                  reasoningDraftStream.forceNewMessage();
                  reasoningEnded = false;
                }
                updateReasoningDraft(payload.text);
              }
            : undefined,
        onReasoningEnd: hasDraftStream
          ? () => {
              reasoningEnded = true;
            }
          : undefined,
        onModelSelected,
      },
    }));
  } finally {
    if (finalizedPreviewIds.size === 0) {
      await answerDraftStream?.clear();
      // Also clear reasoning stream if it is a separate object from the answer stream.
      if (reasoningDraftStream && reasoningDraftStream !== answerDraftStream) {
        await reasoningDraftStream.clear();
      }
    }
    void answerDraftStream?.stop();
    // Only stop reasoning stream separately if it is a distinct object.
    if (reasoningDraftStream && reasoningDraftStream !== answerDraftStream) {
      void reasoningDraftStream.stop();
    }
  }
  let sentFallback = false;
  if (
    !deliveryState.delivered &&
    (deliveryState.skippedNonSilent > 0 || deliveryState.failedDeliveries > 0)
  ) {
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
