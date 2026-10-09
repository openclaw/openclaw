import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { ReplyDeliveryState } from "../../agents/reply-completion.js";
import type {
  PreparedReplyTranscriptStart,
  ReplyDispatchRun,
} from "../../auto-reply/get-reply-options.types.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  isReplyPayloadStatusNotice,
  stripReplyMediaFailureFallback,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import type { ReplyDispatcherOptions } from "../../auto-reply/reply/reply-dispatcher.js";
import type { ReplyDispatchOperation } from "../../auto-reply/reply/reply-dispatcher.types.js";
import {
  resolveSessionTranscriptDatabasePath,
  waitForSessionTranscriptProjection,
} from "../../config/sessions/session-accessor.js";
import { readSessionTranscriptAnchorsAsync } from "../../config/sessions/session-transcript-anchor-read.js";
import type { PrepareAssistantTranscriptMessage } from "../../config/sessions/transcript-assistant-delivery.js";
import { getOwnedSessionTranscriptReader } from "../../config/sessions/transcript-write-context.js";
import { createChannelMessageReplyPipeline } from "../../plugin-sdk/channel-outbound.js";
import { readSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import {
  extractAssistantPhaseText,
  extractAssistantTextForPhase,
} from "../../shared/chat-message-content.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { isToolHistoryBlockType } from "../chat-display-projection.canvas.js";
import { projectChatDisplayMessage } from "../chat-display-projection.js";
import { isSuppressedControlReplyText } from "../control-reply-text.js";
import { attachManagedOutgoingMediaToMessage } from "../managed-image-attachments.js";
import { captureSessionMutationRouting } from "../session-sharing-preparation.js";
import { formatForLog } from "../ws-log.js";
import {
  combineNonStreamingReplyParts,
  extractAssistantDisplayText,
  hasAssistantDisplayMediaContent,
  isMediaBearingPayload,
  prepareAssistantDisplayText,
  sanitizeAssistantDisplayText,
} from "./chat-assistant-content.js";
import { isBtwReplyPayload, isSourceReplyTranscriptMirrorPayload } from "./chat-broadcast.js";
import {
  captureWebchatReplyMediaScope,
  prepareWebchatReplyMediaForDisplay,
  type WebchatReplyMediaRequesterContext,
} from "./chat-reply-media.js";
import {
  buildTranscriptReplyTextFromInputs,
  readChatSendReplyPayload,
  replaceChatSendReplyPayload,
  type DeliveredChatSendReply,
} from "./chat-send-command-replies.js";
import { createAssistantCommentaryMediaCustody } from "./chat-send-commentary-media.js";
import { resolveChatReplyDeliveryFromAnchors } from "./chat-send-reply-delivery.js";
import { retainCommittedChatReplyMedia } from "./chat-send-reply-finalization.js";
import { createChatReplySessionReader, type ChatReplySession } from "./chat-send-reply-session.js";
import { appendInjectedAssistantMessageToTranscript } from "./chat-transcript-inject.js";
import {
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

/** Build delivery options and capture state for the core-owned webchat dispatcher. */
export function createChatSendReplyDispatch(params: {
  getRuntimeConfig: GatewayRequestContext["getRuntimeConfig"];
  accountId: string | undefined;
  requesterContext?: WebchatReplyMediaRequesterContext;
  isAgentRunStarted: () => boolean;
  onCommandBlock?: (text: string) => void;
  isRunCurrent?: () => boolean;
  abortSignal?: AbortSignal;
  assertWorkCurrent?: () => void;
  getReplyDispatchRun?: () => ReplyDispatchRun | undefined;
  prepareAssistantTranscriptMessage?: PrepareAssistantTranscriptMessage;
  logGateway: GatewayRequestContext["logGateway"];
  session: ChatReplySession;
  userTurnRecorder: Pick<UserTurnTranscriptRecorder, "markBlocked" | "getAdmissionReceipt">;
}) {
  const { accountId, getRuntimeConfig, isAgentRunStarted, logGateway, session, userTurnRecorder } =
    params;
  const { backingSessionId, cfg, clientRunId } = session;
  // Extract scalar transcript bindings from borrowed entries; reread after asynchronous work.
  const sessionLoadOptions = { ...session.sessionLoadOptions, clone: false };
  const {
    notePreparedSession,
    readCurrentSession,
    captureTranscriptStart,
    assertRetainedSourceCurrent,
  } = createChatReplySessionReader(session, getRuntimeConfig, params.assertWorkCurrent);
  let assistantTranscriptRewriteState: ReturnType<typeof captureTranscriptStart>;
  let agentRunId = clientRunId;
  const captureAgentTranscriptStart = (
    runId = clientRunId,
    prepared?: PreparedReplyTranscriptStart | null,
  ) => {
    agentRunId = runId;
    const transcriptStart = captureTranscriptStart(prepared);
    assistantTranscriptRewriteState = transcriptStart;
    return transcriptStart !== undefined;
  };
  const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
    cfg,
    agentId: session.agentId,
    channel: INTERNAL_MESSAGE_CHANNEL,
  });
  const deliveredReplies: DeliveredChatSendReply[] = [];
  const finalizedAgentMediaTranscriptKeys = new Set<string>();
  const commentaryMedia = createAssistantCommentaryMediaCustody({
    requesterContext: params.requesterContext,
    session,
    accountId,
    getRunId: () => agentRunId,
    isCurrent: () => isAgentRunStarted() && params.isRunCurrent?.() === true,
    abortSignal: params.abortSignal,
    logGateway,
    prepareAssistantTranscriptMessage: params.prepareAssistantTranscriptMessage,
  });
  const resolveReplyDelivery = async (
    minimumAssistantMessageIndex = 0,
  ): Promise<ReplyDeliveryState> => {
    const admission = userTurnRecorder.getAdmissionReceipt();
    const transcriptStart = assistantTranscriptRewriteState;
    const runId = agentRunId;
    const lifecycleRevision = transcriptStart?.lifecycleRevision;
    const reader = admission && getOwnedSessionTranscriptReader(admission);
    const isRunCurrent = () => {
      const currentAdmission = userTurnRecorder.getAdmissionReceipt();
      return Boolean(
        admission &&
        admission.agentId === session.agentId &&
        admission.sessionKey === session.sessionKey &&
        isAgentRunStarted() &&
        params.isRunCurrent?.() === true &&
        !params.abortSignal?.aborted &&
        agentRunId === runId &&
        assistantTranscriptRewriteState === transcriptStart &&
        currentAdmission?.logicalTurnId === admission.logicalTurnId &&
        currentAdmission?.entryId === admission.entryId,
      );
    };
    const isInspectionCurrent = () => {
      if (!isRunCurrent()) {
        return false;
      }
      assertRetainedSourceCurrent?.();
      reader?.assertCurrent();
      return true;
    };
    const isCurrent = async () => {
      if (!admission || !isRunCurrent()) {
        return false;
      }
      const current = await readCurrentSession();
      return (
        isRunCurrent() &&
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
    if (
      !admission ||
      !transcriptStart ||
      transcriptStart.sessionId !== admission.sessionId ||
      !(reader ? isInspectionCurrent() : await isCurrent())
    ) {
      return "missing";
    }
    const scope = admission;
    // Inspection exposes no result until the final anchor snapshot rechecks the stored session.
    // Between reads, retain physical/run custody; each history operation keeps its own freshness.
    await waitForSessionTranscriptProjection(scope, params.abortSignal);
    if (!(reader || assertRetainedSourceCurrent ? isInspectionCurrent() : await isCurrent())) {
      return "missing";
    }
    const assertRoutingCurrent = captureSessionMutationRouting(getRuntimeConfig());
    let decision: ReplyDeliveryState = "pending";
    await readSessionTranscriptAnchorsAsync(
      scope,
      {
        entryIds: [admission.entryId],
        afterSeq: transcriptStart.afterSeq,
        includeSession: true,
        includeWatermark: true,
        includeMessagesForRunId: runId,
      },
      params.abortSignal,
      (facts) => {
        assertRoutingCurrent(getRuntimeConfig());
        if (
          !isInspectionCurrent() ||
          facts.session?.sessionId !== admission.sessionId ||
          facts.session.lifecycleRevision !== lifecycleRevision ||
          !facts.watermark
        ) {
          decision = "missing";
          return;
        }
        const input = facts.anchors.find((anchor) => anchor.entryId === admission.entryId);
        if (!input || input.rawSeq !== admission.rawSeq) {
          decision = "missing";
          return;
        }
        let latestInput = input;
        for (const row of facts.tail?.entries ?? []) {
          if (
            row.role === "user" &&
            row.anchor &&
            row.anchor.activeMessagePosition > latestInput.activeMessagePosition
          ) {
            latestInput = row.anchor;
          }
        }
        if (minimumAssistantMessageIndex > 0 && latestInput.entryId === input.entryId) {
          decision = "missing";
          return;
        }
        decision = "missing";
        // Payload visibility and anchors were selected in this same history snapshot.
        // The callback consumes them before releasing the FIFO and native mutation witness.
        for (const row of facts.tail?.entries ?? []) {
          const message = asOptionalRecord(row.message);
          if (message?.role !== "assistant" || readSessionTranscriptRunId(message) !== runId) {
            continue;
          }
          const hasTools =
            message.stopReason === "toolUse" ||
            (Array.isArray(message.content) &&
              message.content.some((block) =>
                isToolHistoryBlockType(asOptionalRecord(block)?.type),
              ));
          const answer = hasTools
            ? extractAssistantTextForPhase(message, { phase: "final_answer" })
            : extractAssistantPhaseText(message);
          if (
            !answer ||
            isSuppressedControlReplyText(answer) ||
            !extractAssistantPhaseText(projectChatDisplayMessage(message))
          ) {
            continue;
          }
          const selected = resolveChatReplyDeliveryFromAnchors({
            facts,
            admissionId: admission.entryId,
            inputId: latestInput.entryId,
            messageId: row.entryId,
            afterSeq: transcriptStart.afterSeq,
            watermark: facts.watermark,
            currentWatermark: facts.watermark,
          });
          if (selected !== undefined) {
            decision = selected;
            return;
          }
        }
      },
    );
    assertRoutingCurrent(getRuntimeConfig());
    return isInspectionCurrent() ? decision : "missing";
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
  const appendWebchatAgentMediaTranscriptIfNeeded = async (input: ReplyDispatchOperation) => {
    const payload = readChatSendReplyPayload(input);
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
    const { storePath: latestStorePath, entry: latestEntry } = await readCurrentSession(
      sessionKey,
      agentId,
    );
    const sessionId = latestEntry?.sessionId ?? backingSessionId ?? clientRunId;
    const {
      payloads: [transcriptPayload],
      inputs: transcriptInputs,
      mediaMessage,
      assistantContent,
      persistedAssistantContent,
    } = await prepareWebchatReplyMediaForDisplay({
      scope: mediaScope,
      storePath: latestStorePath,
      inputs: replaceChatSendReplyPayload(input, stripVisibleTextFromTtsSupplement(payload)),
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
      buildTranscriptReplyTextFromInputs(transcriptInputs);
    const payloadMetadata = getReplyPayloadMetadata(payload);
    const sourceMediaUrls = uniqueStrings(
      payloadMetadata?.assistantTranscriptMediaUrls?.length
        ? payloadMetadata.assistantTranscriptMediaUrls
        : [
            ...(Array.isArray(payload.mediaUrls) ? payload.mediaUrls : []),
            ...(typeof payload.mediaUrl === "string" ? [payload.mediaUrl] : []),
          ],
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
    const assistantMessageIndex = payloadMetadata?.assistantMessageIndex;
    let rewritten: { messageId: string } | null = null;
    if (ownedTranscriptIdempotencyKey && transcriptScope) {
      // Receipt identity is not authority after asynchronous media preparation.
      if (
        transcript &&
        (await readCurrentSession(sessionKey, agentId)).entry?.sessionId !== transcript.sessionId
      ) {
        logGateway.warn("webchat runtime-owned media skipped: transcript session changed");
        return;
      }
      // The harness row is the canonical final assistant. Replace that exact
      // identity so media materialization cannot append a parallel reply.
      rewritten = await rewriteAssistantTranscriptMessageByIdempotencyKey({
        content: persistedContentForAppend,
        idempotencyKey: ownedTranscriptIdempotencyKey,
        managedMediaUrls: sourceMediaUrls,
        scope: transcriptScope,
      });
      if (!rewritten) {
        logGateway.warn(
          "webchat runtime-owned assistant media rewrite skipped: transcript identity not found",
        );
        return;
      }
    } else if (assistantMessageIndex !== undefined && transcriptScope) {
      // Embedded runtimes identify their owned turn by message index, not a persisted key.
      // Require that exact current-turn row and media set so a sibling reply cannot be rewritten.
      if (assistantTranscriptRewriteState?.sessionId !== sessionId) {
        return;
      }
      const indexedRewrite = await rewriteAssistantTranscriptMessageByTurnIndexAndMedia({
        afterSeq: assistantTranscriptRewriteState.afterSeq,
        assistantMessageIndex,
        content: persistedContentForAppend,
        expectedGeneration: assistantTranscriptRewriteState.generation,
        mediaUrls: sourceMediaUrls,
        rejectedMediaCount: mediaFailures.filter((failure) => failure.code === "invalid-reference")
          .length,
        scope: transcriptScope,
      });
      if (indexedRewrite) {
        assistantTranscriptRewriteState.generation = indexedRewrite.generation;
        rewritten = indexedRewrite;
      }
    }
    if (rewritten && transcriptScope) {
      finalizedAgentMediaTranscriptKeys.add(finalizationKey);
      if (assistantContent?.length) {
        await attachManagedOutgoingMediaToMessage({
          messageId: rewritten.messageId,
          blocks: assistantContent,
        });
      }
      await publishAssistantTranscriptRewrite({
        scope: transcriptScope,
        rewritten: [rewritten],
      });
      return;
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
    const appended = await appendInjectedAssistantMessageToTranscript({
      sessionKey,
      message: isRuntimeMediaSupplement ? "" : transcriptReply,
      content: appendContent,
      sessionId,
      storePath: latestStorePath,
      agentId,
      // Runtime message identity is the dedupe boundary; distinct rows must not collapse
      // onto the single unkeyed media fallback used by tool/audio-only payloads.
      idempotencyKey:
        assistantMessageIndex !== undefined && assistantMessageIndex >= 1
          ? `${clientRunId}:assistant-media:${assistantMessageIndex}`
          : `${clientRunId}:assistant-media`,
      ttsSupplement: ttsSupplementMarker,
      config: cfg,
      onMessageCommitted: retainCommittedChatReplyMedia,
    });
    if (appended.ok) {
      finalizedAgentMediaTranscriptKeys.add(finalizationKey);
      return;
    }
    logGateway.warn(
      `webchat transcript append failed for media reply: ${appended.error ?? "unknown error"}`,
    );
  };
  const deliverInput = async (
    input: ReplyDispatchOperation,
    info: Parameters<ReplyDispatcherOptions["deliver"]>[1],
  ) => {
    const payload = readChatSendReplyPayload(input);
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
        deliveredReplies.push({ input, kind: info.kind });
        if (
          info.kind === "block" &&
          params.onCommandBlock &&
          !isAgentRunStarted() &&
          params.isRunCurrent?.()
        ) {
          const parts = deliveredReplies.map(({ input: replyInput, kind }) => {
            const reply = readChatSendReplyPayload(replyInput);
            if (kind !== "block" || reply.isReasoning === true || isBtwReplyPayload(reply)) {
              return "";
            }
            const displayText =
              replyInput.kind === "prepared"
                ? prepareAssistantDisplayText
                : sanitizeAssistantDisplayText;
            const text = displayText(reply.text, { preserveBoundaries: true });
            return text && (replyInput.kind === "prepared" || !isSuppressedControlReplyText(text))
              ? text
              : "";
          });
          if (parts.at(-1)) {
            params.onCommandBlock(combineNonStreamingReplyParts(parts));
          }
        }
        break;
      case "tool":
        // TTS tool media becomes a final payload so downstream audio extraction sees it.
        if (isMediaBearingPayload(payload)) {
          const mediaPayload = copyReplyPayloadMetadata(payload, { ...payload, text: undefined });
          deliveredReplies.push(
            ...replaceChatSendReplyPayload(input, mediaPayload).map((mediaInput) => ({
              input: mediaInput,
              kind: "final" as const,
            })),
          );
        }
        break;
    }
  };
  const dispatcherOptions: ReplyDispatcherOptions = {
    ...replyPipeline,
    onError: (err) => {
      logGateway.warn(`webchat dispatch failed: ${formatForLog(err)}`);
    },
    deliver: (payload, info) => deliverInput({ kind: "raw", payload }, info),
    deliverPrepared: (plan, info) => deliverInput({ kind: "prepared", plan }, info),
  };
  const finalizeAgentMediaTranscript = async () => {
    const latestPayloadByKey = new Map<string, ReplyDispatchOperation>();
    for (const { input } of deliveredReplies) {
      const payload = readChatSendReplyPayload(input);
      if (!needsAgentMediaTranscriptFinalization(payload)) {
        continue;
      }
      latestPayloadByKey.set(agentMediaTranscriptKey(payload), input);
    }
    for (const input of latestPayloadByKey.values()) {
      try {
        await appendWebchatAgentMediaTranscriptIfNeeded(input);
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
      try {
        return await commentaryMedia.run(operation);
      } finally {
        const commentaryRewrite = commentaryMedia.lastRewrite;
        if (
          commentaryRewrite &&
          assistantTranscriptRewriteState &&
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
    notePreparedSession,
    deliveredReplies,
    dispatcherOptions,
    hasAppendedWebchatAgentMedia: () => finalizedAgentMediaTranscriptKeys.size > 0,
    onModelSelected,
    prepareAssistantTranscriptMessage: commentaryMedia.prepareAssistantTranscriptMessage,
    resolveReplyDelivery,
    runAgentMediaTranscript,
  };
}
