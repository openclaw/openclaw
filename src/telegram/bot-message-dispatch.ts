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
import type { ReplyPayload } from "../auto-reply/types.js";
import { removeAckReactionAfterReply } from "../channels/ack-reactions.js";
import { logAckFailure, logTypingFailure } from "../channels/logging.js";
import { createReplyPrefixOptions } from "../channels/reply-prefix.js";
import { createTypingCallbacks } from "../channels/typing.js";
import { resolveMarkdownTableMode } from "../config/markdown-tables.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
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
import {
  createTelegramReasoningStepState,
  splitTelegramReasoningText,
} from "./reasoning-lane-coordinator.js";
import { editMessageTelegram } from "./send.js";
import { cacheSticker, describeStickerImage } from "./sticker-cache.js";

const EMPTY_RESPONSE_FALLBACK = "No response generated. Please try again.";

/** Minimum chars before sending first streaming message (improves push notification UX) */
const DRAFT_MIN_INITIAL_CHARS = 30;

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

type TelegramReasoningLevel = "off" | "on" | "stream";

function resolveTelegramReasoningLevel(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  agentId: string;
}): TelegramReasoningLevel {
  const { cfg, sessionKey, agentId } = params;
  if (!sessionKey) {
    return "off";
  }
  try {
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    const store = loadSessionStore(storePath, { skipCache: true });
    const entry = store[sessionKey.toLowerCase()] ?? store[sessionKey];
    const level = entry?.reasoningLevel;
    if (level === "on" || level === "stream") {
      return level;
    }
  } catch {
    // Fall through to default.
  }
  return "off";
}

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
    statusReactionController,
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
  const resolvedReasoningLevel = resolveTelegramReasoningLevel({
    cfg,
    sessionKey: ctxPayload.SessionKey,
    agentId: route.agentId,
  });
  const forceBlockStreamingForReasoning = resolvedReasoningLevel === "on";
  const streamReasoningDraft = resolvedReasoningLevel === "stream";
  const canStreamAnswerDraft =
    streamMode !== "off" && !accountBlockStreamingEnabled && !forceBlockStreamingForReasoning;
  const canStreamReasoningDraft = canStreamAnswerDraft || streamReasoningDraft;
  const draftReplyToMessageId =
    replyToMode !== "off" && typeof msg.message_id === "number" ? msg.message_id : undefined;
  const draftMinInitialChars =
    streamMode === "partial" || streamReasoningDraft ? 1 : DRAFT_MIN_INITIAL_CHARS;
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, route.agentId);
  type LaneName = "answer" | "reasoning";
  type DraftLaneState = {
    stream: ReturnType<typeof createTelegramDraftStream> | undefined;
    lastPartialText: string;
    draftText: string;
    hasStreamedMessage: boolean;
    chunker: EmbeddedBlockChunker | undefined;
  };
  const createDraftLane = (enabled: boolean): DraftLaneState => {
    const stream = enabled
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
    const chunker =
      stream && streamMode === "block"
        ? new EmbeddedBlockChunker(resolveTelegramDraftStreamingChunking(cfg, route.accountId))
        : undefined;
    return {
      stream,
      lastPartialText: "",
      draftText: "",
      hasStreamedMessage: false,
      chunker,
    };
  };
  const lanes: Record<LaneName, DraftLaneState> = {
    answer: createDraftLane(canStreamAnswerDraft),
    reasoning: createDraftLane(canStreamReasoningDraft),
  };
  const answerLane = lanes.answer;
  const reasoningLane = lanes.reasoning;
  let splitReasoningOnNextStream = false;
  const reasoningStepState = createTelegramReasoningStepState();
  type SplitLaneSegment = { lane: LaneName; text: string };
  const splitTextIntoLaneSegments = (text?: string): SplitLaneSegment[] => {
    const split = splitTelegramReasoningText(text);
    const segments: SplitLaneSegment[] = [];
    if (split.reasoningText) {
      segments.push({ lane: "reasoning", text: split.reasoningText });
    }
    if (split.answerText) {
      segments.push({ lane: "answer", text: split.answerText });
    }
    return segments;
  };
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
  const ingestDraftLaneSegments = (text: string | undefined) => {
    for (const segment of splitTextIntoLaneSegments(text)) {
      if (segment.lane === "reasoning") {
        reasoningStepState.noteReasoningHint();
        reasoningStepState.noteReasoningDelivered();
      }
      updateDraftFromPartial(lanes[segment.lane], segment.text);
    }
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
    streamMode === "off"
      ? true
      : forceBlockStreamingForReasoning
        ? false
        : typeof telegramCfg.blockStreaming === "boolean"
          ? !telegramCfg.blockStreaming
          : canStreamAnswerDraft
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
    failedNonSilent: 0,
  };
  const finalizedPreviewByLane: Record<LaneName, boolean> = {
    answer: false,
    reasoning: false,
  };
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
  const getLanePreviewText = (lane: DraftLaneState) =>
    streamMode === "block" ? lane.draftText : lane.lastPartialText;
  const tryUpdatePreviewForLane = async (params: {
    lane: DraftLaneState;
    laneName: LaneName;
    text: string;
    previewButtons?: TelegramInlineButtons;
    stopBeforeEdit?: boolean;
    updateLaneSnapshot?: boolean;
    skipRegressive: "always" | "existingOnly";
    context: "final" | "update";
  }): Promise<boolean> => {
    const {
      lane,
      laneName,
      text,
      previewButtons,
      stopBeforeEdit = false,
      updateLaneSnapshot = false,
      skipRegressive,
      context,
    } = params;
    if (!lane.stream) {
      return false;
    }
    const hadPreviewMessage = typeof lane.stream.messageId() === "number";
    if (stopBeforeEdit) {
      await lane.stream.stop();
    }
    const previewMessageId = lane.stream.messageId();
    if (typeof previewMessageId !== "number") {
      return false;
    }
    const currentPreviewText = getLanePreviewText(lane);
    const shouldSkipRegressive =
      Boolean(currentPreviewText) &&
      currentPreviewText.startsWith(text) &&
      text.length < currentPreviewText.length &&
      (skipRegressive === "always" || hadPreviewMessage);
    if (shouldSkipRegressive) {
      // Avoid regressive punctuation/wording flicker from occasional shorter finals.
      deliveryState.delivered = true;
      return true;
    }
    try {
      await editMessageTelegram(chatId, previewMessageId, text, {
        api: bot.api,
        cfg,
        accountId: route.accountId,
        linkPreview: telegramCfg.linkPreview,
        buttons: previewButtons,
      });
      if (updateLaneSnapshot) {
        lane.lastPartialText = text;
        lane.draftText = text;
      }
      deliveryState.delivered = true;
      return true;
    } catch (err) {
      logVerbose(
        `telegram: ${laneName} preview ${context} edit failed; falling back to standard send (${String(err)})`,
      );
      return false;
    }
  };
  const applyTextToPayload = (payload: ReplyPayload, text: string): ReplyPayload => {
    if (payload.text === text) {
      return payload;
    }
    return { ...payload, text };
  };
  const sendPayload = async (payload: ReplyPayload) => {
    const result = await deliverReplies({
      ...deliveryBaseOptions,
      replies: [payload],
      onVoiceRecording: sendRecordVoice,
    });
    if (result.delivered) {
      deliveryState.delivered = true;
    }
    return result.delivered;
  };
  type LaneDeliveryResult = "preview-finalized" | "preview-updated" | "sent" | "skipped";
  const deliverLaneText = async (params: {
    laneName: LaneName;
    text: string;
    payload: ReplyPayload;
    infoKind: string;
    previewButtons?: TelegramInlineButtons;
    allowPreviewUpdateForNonFinal?: boolean;
  }): Promise<LaneDeliveryResult> => {
    const {
      laneName,
      text,
      payload,
      infoKind,
      previewButtons,
      allowPreviewUpdateForNonFinal = false,
    } = params;
    const lane = lanes[laneName];
    const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
    const canEditViaPreview =
      !hasMedia && text.length > 0 && text.length <= draftMaxChars && !payload.isError;

    if (infoKind === "final") {
      if (canEditViaPreview && !finalizedPreviewByLane[laneName]) {
        await flushDraftLane(lane);
        const finalized = await tryUpdatePreviewForLane({
          lane,
          laneName,
          text,
          previewButtons,
          stopBeforeEdit: true,
          skipRegressive: "existingOnly",
          context: "final",
        });
        if (finalized) {
          finalizedPreviewByLane[laneName] = true;
          return "preview-finalized";
        }
      } else if (!hasMedia && !payload.isError && text.length > draftMaxChars) {
        logVerbose(
          `telegram: preview final too long for edit (${text.length} > ${draftMaxChars}); falling back to standard send`,
        );
      }
      await lane.stream?.stop();
      const delivered = await sendPayload(applyTextToPayload(payload, text));
      return delivered ? "sent" : "skipped";
    }

    if (allowPreviewUpdateForNonFinal && canEditViaPreview) {
      const updated = await tryUpdatePreviewForLane({
        lane,
        laneName,
        text,
        previewButtons,
        stopBeforeEdit: false,
        updateLaneSnapshot: true,
        skipRegressive: "always",
        context: "update",
      });
      if (updated) {
        return "preview-updated";
      }
    }

    const delivered = await sendPayload(applyTextToPayload(payload, text));
    return delivered ? "sent" : "skipped";
  };

  let queuedFinal = false;

  if (statusReactionController) {
    void statusReactionController.setThinking();
  }

  try {
    ({ queuedFinal } = await dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        ...prefixOptions,
        deliver: async (payload, info) => {
          const previewButtons = (
            payload.channelData?.telegram as { buttons?: TelegramInlineButtons } | undefined
          )?.buttons;
          const segments = splitTextIntoLaneSegments(payload.text);
          const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;

          const flushBufferedFinalAnswer = async () => {
            const buffered = reasoningStepState.takeBufferedFinalAnswer();
            if (!buffered) {
              return;
            }
            const bufferedButtons = (
              buffered.payload.channelData?.telegram as
                | { buttons?: TelegramInlineButtons }
                | undefined
            )?.buttons;
            await deliverLaneText({
              laneName: "answer",
              text: buffered.text,
              payload: buffered.payload,
              infoKind: "final",
              previewButtons: bufferedButtons,
            });
            reasoningStepState.resetForNextStep();
          };

          for (const segment of segments) {
            if (
              segment.lane === "answer" &&
              info.kind === "final" &&
              reasoningStepState.shouldBufferFinalAnswer()
            ) {
              reasoningStepState.bufferFinalAnswer({ payload, text: segment.text });
              continue;
            }
            if (segment.lane === "reasoning") {
              reasoningStepState.noteReasoningHint();
            }
            const result = await deliverLaneText({
              laneName: segment.lane,
              text: segment.text,
              payload,
              infoKind: info.kind,
              previewButtons,
              allowPreviewUpdateForNonFinal: segment.lane === "reasoning",
            });
            if (segment.lane === "reasoning") {
              if (result !== "skipped") {
                reasoningStepState.noteReasoningDelivered();
                await flushBufferedFinalAnswer();
              }
              continue;
            }
            if (info.kind === "final") {
              if (reasoningLane.hasStreamedMessage) {
                finalizedPreviewByLane.reasoning = true;
              }
              reasoningStepState.resetForNextStep();
            }
          }
          if (segments.length > 0) {
            return;
          }

          if (info.kind === "final") {
            await answerLane.stream?.stop();
            await reasoningLane.stream?.stop();
            reasoningStepState.resetForNextStep();
          }
          const canSendAsIs =
            hasMedia || typeof payload.text !== "string" || payload.text.length > 0;
          if (!canSendAsIs) {
            if (info.kind === "final") {
              await flushBufferedFinalAnswer();
            }
            return;
          }
          await sendPayload(payload);
          if (info.kind === "final") {
            await flushBufferedFinalAnswer();
          }
        },
        onSkip: (_payload, info) => {
          if (info.reason !== "silent") {
            deliveryState.skippedNonSilent += 1;
          }
        },
        onError: (err, info) => {
          deliveryState.failedNonSilent += 1;
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
        onPartialReply:
          answerLane.stream || reasoningLane.stream
            ? (payload) => ingestDraftLaneSegments(payload.text)
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
              ingestDraftLaneSegments(payload.text);
            }
          : undefined,
        onAssistantMessageStart: answerLane.stream
          ? () => {
              reasoningStepState.resetForNextStep();
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
        onToolStart: statusReactionController
          ? async (payload) => {
              await statusReactionController.setTool(payload.name);
            }
          : undefined,
        onModelSelected,
      },
    }));
  } finally {
    // Must stop() first to flush debounced content before clear() wipes state.
    const streamCleanupStates = new Map<
      NonNullable<DraftLaneState["stream"]>,
      { shouldClear: boolean }
    >();
    const lanesToCleanup: Array<{ laneName: LaneName; lane: DraftLaneState }> = [
      { laneName: "answer", lane: answerLane },
      { laneName: "reasoning", lane: reasoningLane },
    ];
    for (const laneState of lanesToCleanup) {
      const stream = laneState.lane.stream;
      if (!stream) {
        continue;
      }
      const shouldClear = !finalizedPreviewByLane[laneState.laneName];
      const existing = streamCleanupStates.get(stream);
      if (!existing) {
        streamCleanupStates.set(stream, { shouldClear });
        continue;
      }
      existing.shouldClear = existing.shouldClear && shouldClear;
    }
    for (const [stream, cleanupState] of streamCleanupStates) {
      await stream.stop();
      if (cleanupState.shouldClear) {
        await stream.clear();
      }
    }
  }
  let sentFallback = false;
  if (
    !deliveryState.delivered &&
    (deliveryState.skippedNonSilent > 0 || deliveryState.failedNonSilent > 0)
  ) {
    const result = await deliverReplies({
      replies: [{ text: EMPTY_RESPONSE_FALLBACK }],
      ...deliveryBaseOptions,
    });
    sentFallback = result.delivered;
  }

  const hasFinalResponse = queuedFinal || sentFallback;

  if (statusReactionController && !hasFinalResponse) {
    void statusReactionController.setError().catch((err) => {
      logVerbose(`telegram: status reaction error finalize failed: ${String(err)}`);
    });
  }

  if (!hasFinalResponse) {
    clearGroupHistory();
    return;
  }

  if (statusReactionController) {
    void statusReactionController.setDone().catch((err) => {
      logVerbose(`telegram: status reaction finalize failed: ${String(err)}`);
    });
  } else {
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
  }
  clearGroupHistory();
};
