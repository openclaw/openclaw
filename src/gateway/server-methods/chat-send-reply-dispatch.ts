import { isAudioFileName } from "@openclaw/media-core/mime";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyDeliveryState } from "../../agents/reply-completion.js";
import type { ReplyDispatchRun } from "../../auto-reply/get-reply-options.types.js";
import {
  getReplyPayloadMetadata,
  isReplyPayloadStatusNotice,
  stripReplyMediaFailureFallback,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import type { ReplyDispatcherOptions } from "../../auto-reply/reply/reply-dispatcher.js";
import {
  loadTranscriptEventRowsAfterSeqSync,
  readActiveTranscriptEntryAnchor,
  readSessionTranscriptWatermark,
  resolveSessionTranscriptDatabasePath,
  waitForSessionTranscriptProjection,
} from "../../config/sessions/session-accessor.js";
import {
  recordAssistantManagedMediaUrls,
  type PrepareAssistantTranscriptMessage,
} from "../../config/sessions/transcript-assistant-delivery.js";
import { splitMediaFromOutput } from "../../media/parse.js";
import { createChannelMessageReplyPipeline } from "../../plugin-sdk/channel-outbound.js";
import { readSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import {
  extractAssistantPhaseText,
  extractAssistantTextForPhase,
} from "../../shared/chat-message-content.js";
import {
  parseInlineDirectives,
  stripInlineDirectiveTagsForDelivery,
  sanitizeReplyDirectiveId,
} from "../../utils/directive-tags.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { isToolHistoryBlockType } from "../chat-display-projection.canvas.js";
import { projectChatDisplayMessage } from "../chat-display-projection.js";
import { isSuppressedControlReplyText } from "../control-reply-text.js";
import { attachManagedOutgoingMediaToMessage } from "../managed-image-attachments.js";
import { readSessionMessageByIdAsync } from "../session-transcript-readers.js";
import { loadSessionEntry } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import {
  combineNonStreamingReplyParts,
  extractAssistantDisplayText,
  hasAssistantDisplayMediaContent,
  isMediaBearingPayload,
  sanitizeAssistantDisplayText,
} from "./chat-assistant-content.js";
import { isBtwReplyPayload, isSourceReplyTranscriptMirrorPayload } from "./chat-broadcast.js";
import {
  captureWebchatReplyMediaScope,
  prepareWebchatReplyMediaForDisplay,
  type WebchatReplyMediaRequesterContext,
} from "./chat-reply-media.js";
import { observeChatSendCommentaryMedia } from "./chat-send-commentary-media.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import {
  appendAssistantTranscriptMessage,
  assistantTranscriptScope,
  publishAssistantTranscriptRewrite,
  rewriteAssistantTranscriptMessageByIdempotencyKey,
  rewriteAssistantTranscriptMessageByTurnIndexAndMedia,
} from "./chat-transcript-persistence.js";
import {
  buildTtsSupplementTranscriptMarker,
  stripVisibleTextFromTtsSupplement,
} from "./chat-tts-markers.js";
import type { GatewayRequestContext } from "./types.js";

type DeliveredChatSendReply = {
  payload: ReplyPayload;
  kind: "block" | "final";
};

export function buildTranscriptReplyText(payloads: ReplyPayload[]): string {
  const chunks = payloads
    .map((payload) => {
      if (payload.isReasoning === true) {
        return "";
      }
      const parts = resolveSendableOutboundReplyParts(payload);
      const lines: string[] = [];
      const parsedText = payload.text?.includes("[[")
        ? parseInlineDirectives(payload.text)
        : undefined;
      const replyToId =
        sanitizeReplyDirectiveId(payload.replyToId) ??
        sanitizeReplyDirectiveId(parsedText?.replyToExplicitId);
      if (replyToId) {
        lines.push(`[[reply_to:${replyToId}]]`);
      } else if (payload.replyToCurrent || parsedText?.replyToCurrent) {
        lines.push("[[reply_to_current]]");
      }
      const text = payload.text ? stripInlineDirectiveTagsForDelivery(payload.text).text : "";
      if (text.trim() && !isSuppressedControlReplyText(text)) {
        lines.push(text);
      }
      for (const mediaUrl of parts.mediaUrls) {
        if (payload.sensitiveMedia === true) {
          continue;
        }
        const trimmed = mediaUrl.trim();
        if (trimmed) {
          lines.push(`Attachment: ${trimmed}`);
        }
      }
      if (
        (payload.audioAsVoice || parsedText?.audioAsVoice) &&
        parts.mediaUrls.some((mediaUrl) => isAudioFileName(mediaUrl))
      ) {
        lines.push("[[audio_as_voice]]");
      }
      return lines.join("\n");
    })
    .filter(Boolean);
  return combineNonStreamingReplyParts(chunks);
}

/** Build delivery options and capture state for the core-owned webchat dispatcher. */
export function createChatSendReplyDispatch(params: {
  accountId: string | undefined;
  requesterContext?: WebchatReplyMediaRequesterContext;
  isAgentRunStarted: () => boolean;
  onCommandBlock?: (text: string) => void;
  isRunCurrent?: () => boolean;
  abortSignal?: AbortSignal;
  getReplyDispatchRun?: () => ReplyDispatchRun | undefined;
  prepareAssistantTranscriptMessage?: PrepareAssistantTranscriptMessage;
  logGateway: GatewayRequestContext["logGateway"];
  session: Pick<
    PreparedChatSendSession,
    "agentId" | "backingSessionId" | "cfg" | "clientRunId" | "sessionKey" | "sessionLoadOptions"
  >;
  userTurnRecorder: Pick<UserTurnTranscriptRecorder, "markBlocked" | "getAdmissionReceipt">;
}) {
  const { accountId, isAgentRunStarted, logGateway, session, userTurnRecorder } = params;
  const { backingSessionId, cfg, clientRunId } = session;
  // Extract scalar transcript bindings from borrowed entries; reread after asynchronous work.
  const sessionLoadOptions = { ...session.sessionLoadOptions, clone: false };
  let assistantTranscriptRewriteState = {
    sessionId: undefined as string | undefined,
    generation: null as string | null,
    afterSeq: 0,
  };
  let agentRunId = clientRunId;
  let agentTranscriptLifecycleRevision: string | undefined;
  const captureAgentTranscriptStart = (runId = clientRunId) => {
    agentRunId = runId;
    const current = loadSessionEntry(session.sessionKey, sessionLoadOptions);
    const sessionId = current.entry?.sessionId ?? backingSessionId;
    const watermark = sessionId
      ? readSessionTranscriptWatermark({
          agentId: session.agentId,
          sessionId,
          sessionKey: session.sessionKey,
          storePath: current.storePath,
        })
      : { generation: null, maxSeq: null };
    assistantTranscriptRewriteState = {
      sessionId,
      generation: watermark.generation,
      afterSeq: watermark.maxSeq ?? 0,
    };
    agentTranscriptLifecycleRevision = current.entry?.lifecycleRevision;
    return true;
  };
  const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
    cfg,
    agentId: session.agentId,
    channel: INTERNAL_MESSAGE_CHANNEL,
  });
  const deliveredReplies: DeliveredChatSendReply[] = [];
  const finalizedAgentMediaTranscriptKeys = new Set<string>();
  let appendedWebchatAgentMedia = false;
  let preparingTranscript = false;
  const prepareAssistantTranscriptMessage: PrepareAssistantTranscriptMessage = (
    message,
    sourceText,
  ) => {
    if (!preparingTranscript || !isAgentRunStarted() || !params.isRunCurrent?.() || !sourceText) {
      return message;
    }
    // Record delivery ownership before publication, while preserving raw refs for
    // the exact-row materializer. This is display provenance, never local-file trust.
    const prepared = recordAssistantManagedMediaUrls(
      message,
      splitMediaFromOutput(sourceText).mediaUrls,
    );
    return params.prepareAssistantTranscriptMessage?.(prepared, sourceText) ?? prepared;
  };
  const resolveReplyDelivery = async (
    minimumAssistantMessageIndex = 0,
  ): Promise<ReplyDeliveryState> => {
    const admission = userTurnRecorder.getAdmissionReceipt();
    const transcriptStart = assistantTranscriptRewriteState;
    const runId = agentRunId;
    const lifecycleRevision = agentTranscriptLifecycleRevision;
    const isCurrent = () => {
      const currentAdmission = userTurnRecorder.getAdmissionReceipt();
      if (
        !admission ||
        admission.agentId !== session.agentId ||
        admission.sessionKey !== session.sessionKey ||
        !isAgentRunStarted() ||
        params.isRunCurrent?.() !== true ||
        params.abortSignal?.aborted ||
        agentRunId !== runId ||
        assistantTranscriptRewriteState !== transcriptStart ||
        currentAdmission?.logicalTurnId !== admission.logicalTurnId ||
        currentAdmission?.entryId !== admission.entryId
      ) {
        return false;
      }
      const current = loadSessionEntry(session.sessionKey, sessionLoadOptions);
      return (
        current.entry?.sessionId === admission.sessionId &&
        current.entry.lifecycleRevision === lifecycleRevision &&
        resolveSessionTranscriptDatabasePath({
          agentId: session.agentId,
          sessionId: admission.sessionId,
          sessionKey: session.sessionKey,
          storePath: current.storePath,
        }) === admission.storePath
      );
    };
    if (!admission || transcriptStart.sessionId !== admission.sessionId || !isCurrent()) {
      return "missing";
    }
    const scope = admission;
    await waitForSessionTranscriptProjection(scope);
    if (!isCurrent()) {
      return "missing";
    }
    const input = readActiveTranscriptEntryAnchor(admission);
    if (!input || input.rawSeq !== admission.rawSeq) {
      return "missing";
    }
    const watermark = readSessionTranscriptWatermark(scope);
    let latestInputPosition = input.activeMessagePosition;
    let latestInputId = input.entryId;
    const candidateIds: string[] = [];
    // Stream indices also advance between content blocks. Fence with committed input
    // identities instead of treating the number of persisted assistant rows as an index.
    for (const { event } of loadTranscriptEventRowsAfterSeqSync(scope, transcriptStart.afterSeq)) {
      const row = asOptionalRecord(event);
      const message = asOptionalRecord(row?.message);
      if (typeof row?.id !== "string") {
        continue;
      }
      if (message?.role === "user") {
        const anchor = readActiveTranscriptEntryAnchor({ ...scope, entryId: row.id });
        if (anchor && anchor.activeMessagePosition > latestInputPosition) {
          latestInputPosition = anchor.activeMessagePosition;
          latestInputId = anchor.entryId;
        }
      } else if (message?.role === "assistant" && readSessionTranscriptRunId(message) === runId) {
        candidateIds.push(row.id);
      }
    }
    if (minimumAssistantMessageIndex > 0 && latestInputId === input.entryId) {
      return "missing";
    }
    for (const messageId of candidateIds) {
      const stored = await readSessionMessageByIdAsync(scope, messageId, {
        currentOnly: true,
        maxBytes: Number.MAX_SAFE_INTEGER,
      });
      if (!isCurrent() || !readActiveTranscriptEntryAnchor(admission)) {
        return "missing";
      }
      if (!stored.found) {
        continue;
      }
      const currentInput = readActiveTranscriptEntryAnchor({ ...scope, entryId: latestInputId });
      if (!currentInput) {
        return "missing";
      }
      const anchor = readActiveTranscriptEntryAnchor({ ...scope, entryId: messageId });
      const message = asOptionalRecord(stored.message);
      if (
        !anchor ||
        anchor.rawSeq <= transcriptStart.afterSeq ||
        anchor.activeMessagePosition <= currentInput.activeMessagePosition ||
        message?.role !== "assistant" ||
        readSessionTranscriptRunId(message) !== runId
      ) {
        continue;
      }
      const hasTools =
        message.stopReason === "toolUse" ||
        (Array.isArray(message.content) &&
          message.content.some((block) => isToolHistoryBlockType(asOptionalRecord(block)?.type)));
      const answer = hasTools
        ? extractAssistantTextForPhase(message, { phase: "final_answer" })
        : extractAssistantPhaseText(message);
      if (
        answer &&
        !isSuppressedControlReplyText(answer) &&
        extractAssistantPhaseText(projectChatDisplayMessage(message))
      ) {
        const currentWatermark = readSessionTranscriptWatermark(scope);
        if (
          currentWatermark.generation !== watermark.generation ||
          currentWatermark.maxSeq !== watermark.maxSeq
        ) {
          // A benign rewrite must not authorize another answer, but a newly committed
          // input still owns a distinct obligation even while this row is being read.
          for (const { event } of loadTranscriptEventRowsAfterSeqSync(
            scope,
            transcriptStart.afterSeq,
          )) {
            const row = asOptionalRecord(event);
            if (asOptionalRecord(row?.message)?.role !== "user" || typeof row?.id !== "string") {
              continue;
            }
            const newerInput = readActiveTranscriptEntryAnchor({ ...scope, entryId: row.id });
            if (newerInput && newerInput.activeMessagePosition > anchor.activeMessagePosition) {
              return "missing";
            }
          }
          return "pending";
        }
        return "delivered";
      }
    }
    return "missing";
  };
  const needsAgentMediaTranscriptFinalization = (payload: ReplyPayload): boolean =>
    isMediaBearingPayload(payload) ||
    Boolean(getReplyPayloadMetadata(payload)?.assistantMediaFailures?.length);
  const agentMediaTranscriptKey = (payload: ReplyPayload): string => {
    const metadata = getReplyPayloadMetadata(payload);
    const ownedIdempotencyKey =
      metadata?.assistantTranscriptOwned === true
        ? metadata.assistantTranscriptIdempotencyKey?.trim()
        : undefined;
    if (ownedIdempotencyKey) {
      return `owned:${ownedIdempotencyKey}`;
    }
    if (metadata?.assistantMessageIndex !== undefined) {
      return `index:${metadata.assistantMessageIndex}`;
    }
    return "unkeyed";
  };
  const appendWebchatAgentMediaTranscriptIfNeeded = async (payload: ReplyPayload) => {
    if (!isAgentRunStarted() || !needsAgentMediaTranscriptFinalization(payload)) {
      return;
    }
    const finalizationKey = agentMediaTranscriptKey(payload);
    if (finalizedAgentMediaTranscriptKeys.has(finalizationKey)) {
      return;
    }
    if (isSourceReplyTranscriptMirrorPayload(payload)) {
      return;
    }
    const replyDispatchRun = params.getReplyDispatchRun?.();
    const transcript = replyDispatchRun?.getResult().assistantTranscript;
    if (replyDispatchRun && !transcript) {
      logGateway.warn(
        "webchat runtime-owned media skipped: assistant transcript was not persisted",
      );
      return;
    }
    const sessionKey = transcript?.sessionKey ?? session.sessionKey;
    const agentId = transcript?.agentId ?? session.agentId;
    const ttsSupplementMarker = buildTtsSupplementTranscriptMarker(payload);
    const mediaScope = captureWebchatReplyMediaScope({
      requesterContext: params.requesterContext,
      cfg,
      sessionKey,
      agentId,
      sessionLoadOptions: { ...sessionLoadOptions, agentId },
      accountId,
      assertCurrent: () => {
        params.abortSignal?.throwIfAborted();
        if (params.isRunCurrent && !params.isRunCurrent()) {
          throw new Error("Chat media run is no longer current.");
        }
      },
    });
    const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(sessionKey, {
      ...sessionLoadOptions,
      ...(agentId ? { agentId } : {}),
    });
    const sessionId = latestEntry?.sessionId ?? backingSessionId ?? clientRunId;
    const {
      payloads: [transcriptPayload],
      mediaMessage,
      assistantContent,
      persistedAssistantContent,
    } = await prepareWebchatReplyMediaForDisplay({
      scope: mediaScope,
      storePath: latestStorePath,
      payloads: [stripVisibleTextFromTtsSupplement(payload)],
      abortSignal: params.abortSignal,
      includeSensitiveMedia: payload.sensitiveMedia !== true,
      onLocalAudioAccessDenied: (err) => {
        logGateway.warn(`webchat audio embedding denied local path: ${formatForLog(err)}`);
      },
      onManagedMediaPrepareError: (message) => {
        logGateway.warn(`webchat media embedding skipped attachment: ${message}`);
      },
    });
    if (!transcriptPayload) {
      return;
    }
    const transcriptPayloadMetadata = getReplyPayloadMetadata(transcriptPayload);
    const mediaFailures = transcriptPayloadMetadata?.assistantMediaFailures ?? [];
    const mediaNormalizationFailed = mediaFailures.length > 0;
    const persistedContentForAppend =
      hasAssistantDisplayMediaContent(persistedAssistantContent) || mediaNormalizationFailed
        ? persistedAssistantContent
        : undefined;
    if (!persistedContentForAppend?.length) {
      return;
    }
    const transcriptReply =
      mediaMessage?.transcriptText ??
      extractAssistantDisplayText(assistantContent) ??
      buildTranscriptReplyText([transcriptPayload]);
    const payloadMetadata = getReplyPayloadMetadata(payload);
    const sourceMediaUrls = Array.from(
      new Set(
        payloadMetadata?.assistantTranscriptMediaUrls?.length
          ? payloadMetadata.assistantTranscriptMediaUrls
          : [
              ...(Array.isArray(payload.mediaUrls) ? payload.mediaUrls : []),
              ...(typeof payload.mediaUrl === "string" ? [payload.mediaUrl] : []),
            ],
      ),
    );
    const ownedTranscriptIdempotencyKey =
      transcript?.idempotencyKey ??
      (payloadMetadata?.assistantTranscriptOwned === true
        ? payloadMetadata.assistantTranscriptIdempotencyKey?.trim()
        : undefined);
    const transcriptScope = assistantTranscriptScope({
      sessionKey,
      sessionId,
      storePath: latestStorePath,
      agentId,
    });
    if (ownedTranscriptIdempotencyKey && transcriptScope) {
      // Receipt identity is not authority after asynchronous media preparation.
      if (
        transcript &&
        loadSessionEntry(sessionKey, { ...sessionLoadOptions, agentId }).entry?.sessionId !==
          transcript.sessionId
      ) {
        logGateway.warn("webchat runtime-owned media skipped: transcript session changed");
        return;
      }
      // The harness row is the canonical final assistant. Replace that exact
      // identity so media materialization cannot append a parallel reply.
      const rewritten = await rewriteAssistantTranscriptMessageByIdempotencyKey({
        content: persistedContentForAppend,
        idempotencyKey: ownedTranscriptIdempotencyKey,
        managedMediaUrls: sourceMediaUrls,
        scope: transcriptScope,
      });
      if (rewritten) {
        appendedWebchatAgentMedia = true;
        finalizedAgentMediaTranscriptKeys.add(finalizationKey);
        await publishAssistantTranscriptRewrite({
          scope: transcriptScope,
          rewritten: [rewritten],
        });
        if (assistantContent?.length) {
          attachManagedOutgoingMediaToMessage({
            messageId: rewritten.messageId,
            blocks: assistantContent,
          });
        }
        return;
      }
      logGateway.warn(
        "webchat runtime-owned assistant media rewrite skipped: transcript identity not found",
      );
      return;
    }
    const assistantMessageIndex = payloadMetadata?.assistantMessageIndex;
    if (assistantMessageIndex !== undefined && transcriptScope) {
      // Embedded runtimes identify their owned turn by message index, not a persisted key.
      // Require that exact current-turn row and media set so a sibling reply cannot be rewritten.
      if (assistantTranscriptRewriteState.sessionId !== sessionId) {
        assistantTranscriptRewriteState = {
          sessionId,
          generation: null,
          afterSeq: 0,
        };
      }
      const rewritten = await rewriteAssistantTranscriptMessageByTurnIndexAndMedia({
        afterSeq: assistantTranscriptRewriteState.afterSeq,
        assistantMessageIndex,
        content: persistedContentForAppend,
        expectedGeneration: assistantTranscriptRewriteState.generation,
        mediaUrls: sourceMediaUrls,
        scope: transcriptScope,
      });
      if (rewritten) {
        assistantTranscriptRewriteState.generation = rewritten.generation;
        appendedWebchatAgentMedia = true;
        finalizedAgentMediaTranscriptKeys.add(finalizationKey);
        await publishAssistantTranscriptRewrite({
          scope: transcriptScope,
          rewritten: [rewritten],
        });
        if (assistantContent?.length) {
          attachManagedOutgoingMediaToMessage({
            messageId: rewritten.messageId,
            blocks: assistantContent,
          });
        }
        return;
      }
    }
    const hasOnlyFailureDisplay =
      persistedContentForAppend.some((block) => block.type === "attachment_error") &&
      persistedContentForAppend.every(
        (block) => block.type === "text" || block.type === "attachment_error",
      );
    const runtimeOwnedText = stripReplyMediaFailureFallback(
      transcriptPayload.text,
      mediaFailures,
    )?.trim();
    if (
      assistantMessageIndex === undefined &&
      mediaNormalizationFailed &&
      hasOnlyFailureDisplay &&
      runtimeOwnedText
    ) {
      // Agent message_end owns the text row. Without its identity, appending a failure card
      // would duplicate that row; the live broadcast still carries the visible failure.
      return;
    }
    const isRuntimeMediaSupplement =
      assistantMessageIndex !== undefined &&
      assistantMessageIndex >= 1 &&
      !mediaNormalizationFailed &&
      !ttsSupplementMarker &&
      !payload.isError &&
      !isReplyPayloadStatusNotice(payload) &&
      !payloadMetadata?.toolErrorWarning &&
      !payloadMetadata?.nonTerminalToolErrorWarning &&
      !payloadMetadata?.terminalProviderError;
    // The runtime owns text persistence, including hook suppression. Queued tool media
    // can supplement that turn without recreating text when the exact rewrite cannot match.
    const appendContent = isRuntimeMediaSupplement
      ? persistedContentForAppend.filter((block) => block.type !== "text")
      : persistedContentForAppend;
    const appended = await appendAssistantTranscriptMessage({
      sessionKey,
      message: isRuntimeMediaSupplement ? "" : transcriptReply,
      content: appendContent,
      sessionId,
      storePath: latestStorePath,
      agentId,
      createIfMissing: true,
      // Runtime message identity is the dedupe boundary; distinct rows must not collapse
      // onto the single unkeyed media fallback used by tool/audio-only payloads.
      idempotencyKey:
        assistantMessageIndex !== undefined && assistantMessageIndex >= 1
          ? `${clientRunId}:assistant-media:${assistantMessageIndex}`
          : `${clientRunId}:assistant-media`,
      ttsSupplement: ttsSupplementMarker,
      cfg,
    });
    if (appended.ok) {
      if (appended.messageId && assistantContent?.length) {
        attachManagedOutgoingMediaToMessage({
          messageId: appended.messageId,
          blocks: assistantContent,
        });
      }
      appendedWebchatAgentMedia = true;
      finalizedAgentMediaTranscriptKeys.add(finalizationKey);
      return;
    }
    logGateway.warn(
      `webchat transcript append failed for media reply: ${appended.error ?? "unknown error"}`,
    );
  };
  const dispatcherOptions: ReplyDispatcherOptions = {
    ...replyPipeline,
    onError: (err) => {
      logGateway.warn(`webchat dispatch failed: ${formatForLog(err)}`);
    },
    deliver: async (payload, info) => {
      const payloadMetadata = getReplyPayloadMetadata(payload);
      if (
        payloadMetadata?.beforeAgentRunBlocked === true ||
        payloadMetadata?.sourceReplyTranscriptMirror?.transcriptWriteBlocked === true
      ) {
        userTurnRecorder.markBlocked();
      }
      switch (info.kind) {
        case "block":
        case "final":
          deliveredReplies.push({ payload, kind: info.kind });
          if (
            info.kind === "block" &&
            params.onCommandBlock &&
            !isAgentRunStarted() &&
            params.isRunCurrent?.()
          ) {
            const parts = deliveredReplies.map(({ payload: reply, kind }) => {
              if (kind !== "block" || reply.isReasoning === true || isBtwReplyPayload(reply)) {
                return "";
              }
              const text = sanitizeAssistantDisplayText(reply.text, { preserveBoundaries: true });
              return text && !isSuppressedControlReplyText(text) ? text : "";
            });
            if (parts.at(-1)) {
              params.onCommandBlock(combineNonStreamingReplyParts(parts));
            }
          }
          break;
        case "tool":
          // TTS tool media becomes a final payload so downstream audio extraction sees it.
          if (isMediaBearingPayload(payload)) {
            deliveredReplies.push({
              payload: { ...payload, text: undefined },
              kind: "final",
            });
          }
          break;
      }
    },
  };
  const finalizeAgentMediaTranscript = async () => {
    const latestPayloadByKey = new Map<string, ReplyPayload>();
    for (const { payload } of deliveredReplies) {
      if (!needsAgentMediaTranscriptFinalization(payload)) {
        continue;
      }
      latestPayloadByKey.set(agentMediaTranscriptKey(payload), payload);
    }
    for (const payload of latestPayloadByKey.values()) {
      try {
        await appendWebchatAgentMediaTranscriptIfNeeded(payload);
      } catch (error) {
        logGateway.warn(`webchat media finalization failed: ${formatForLog(error)}`);
      }
    }
  };
  const runAgentMediaTranscript = async <T>(
    admission: { run: (operation: () => Promise<T>) => Promise<T> },
    operation: () => Promise<T>,
  ): Promise<T> => {
    return await admission.run(async () => {
      preparingTranscript = true;
      const commentaryMedia = observeChatSendCommentaryMedia({
        requesterContext: params.requesterContext,
        session,
        accountId,
        getRunId: () => agentRunId,
        isCurrent: () => isAgentRunStarted() && params.isRunCurrent?.() === true,
        abortSignal: params.abortSignal,
        logGateway,
      });
      try {
        return await operation();
      } finally {
        preparingTranscript = false;
        const commentaryRewrite = await commentaryMedia.close();
        if (
          commentaryRewrite &&
          commentaryRewrite.sessionId === assistantTranscriptRewriteState.sessionId
        ) {
          assistantTranscriptRewriteState.generation = commentaryRewrite.generation;
        }
        // Stay inside the session admission after the runtime owner unwinds; callers chain
        // post-dispatch persistence from this Promise, and finalizer errors stay best-effort.
        await finalizeAgentMediaTranscript();
      }
    });
  };
  return {
    captureAgentTranscriptStart,
    deliveredReplies,
    dispatcherOptions,
    hasAppendedWebchatAgentMedia: () => appendedWebchatAgentMedia,
    onModelSelected,
    prepareAssistantTranscriptMessage,
    resolveReplyDelivery,
    runAgentMediaTranscript,
  };
}
