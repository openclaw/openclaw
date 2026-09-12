import { isAudioFileName } from "@openclaw/media-core/mime";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyDispatchRun } from "../../auto-reply/get-reply-options.types.js";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  isReplyPayloadStatusNotice,
  stripReplyMediaFailureFallback,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import {
  deferModelPolicyNoticeAcknowledgment,
  persistModelNoticeTranscript,
  settleModelPolicyNoticePublication,
  waitForModelPolicyNoticePublication,
  type ModelNoticeTranscript,
} from "../../auto-reply/reply/model-notice-publication.js";
import type { ReplyDispatcherOptions } from "../../auto-reply/reply/reply-dispatcher.js";
import { readSessionTranscriptWatermark } from "../../config/sessions/session-accessor.js";
import {
  recordAssistantManagedMediaUrls,
  type PrepareAssistantTranscriptMessage,
} from "../../config/sessions/transcript-assistant-delivery.js";
import {
  publishAssistantTranscriptRewrite,
  rewriteAssistantTranscriptMessageByTurnIdentity,
} from "../../config/sessions/transcript-assistant-rewrite.js";
import {
  appendLocalMediaParentRoots,
  getAgentScopedMediaLocalRoots,
} from "../../media/local-roots.js";
import { splitMediaFromOutput } from "../../media/parse.js";
import { createChannelMessageReplyPipeline } from "../../plugin-sdk/channel-outbound.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import {
  parseInlineDirectives,
  stripInlineDirectiveTagsForDelivery,
  sanitizeReplyDirectiveId,
} from "../../utils/directive-tags.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { isSuppressedControlReplyText } from "../control-reply-text.js";
import { attachManagedOutgoingMediaToMessage } from "../managed-image-attachments.js";
import { loadSessionEntry } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import {
  buildAssistantReplyContent,
  combineNonStreamingReplyParts,
  extractAssistantDisplayText,
  hasAssistantDisplayMediaContent,
  isMediaBearingPayload,
  sanitizeAssistantDisplayText,
} from "./chat-assistant-content.js";
import { isBtwReplyPayload, isSourceReplyTranscriptMirrorPayload } from "./chat-broadcast.js";
import { normalizeWebchatReplyMediaPathsForDisplay } from "./chat-reply-media.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import {
  appendAssistantTranscriptMessage,
  assistantTranscriptScope,
  buildAssistantDisplayRewrite,
  rewriteAssistantTranscriptMessageByIdempotencyKey,
} from "./chat-transcript-persistence.js";
import {
  buildTtsSupplementTranscriptMarker,
  stripVisibleTextFromTtsSupplement,
} from "./chat-tts-markers.js";
import { buildWebchatAssistantMessageFromReplyPayloads } from "./chat-webchat-media.js";
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
  isAgentRunStarted: () => boolean;
  onCommandBlock?: (text: string) => void;
  isRunCurrent?: () => boolean;
  getReplyDispatchRun?: () => ReplyDispatchRun | undefined;
  prepareAssistantTranscriptMessage?: PrepareAssistantTranscriptMessage;
  logGateway: GatewayRequestContext["logGateway"];
  session: Pick<
    PreparedChatSendSession,
    "agentId" | "backingSessionId" | "cfg" | "clientRunId" | "sessionKey" | "sessionLoadOptions"
  >;
  userTurnRecorder: Pick<UserTurnTranscriptRecorder, "markBlocked">;
}) {
  const { accountId, isAgentRunStarted, logGateway, session, userTurnRecorder } = params;
  const { backingSessionId, cfg, clientRunId } = session;
  // Extract scalar transcript bindings from borrowed entries; reread after asynchronous work.
  const sessionLoadOptions = { ...session.sessionLoadOptions, clone: false };
  let assistantTranscriptRewriteState: {
    sessionId: string | undefined;
    generation: string | null;
    afterSeq: number;
    noticeTranscript: ModelNoticeTranscript | undefined;
  } = {
    sessionId: undefined,
    generation: null,
    afterSeq: 0,
    noticeTranscript: undefined,
  };
  const captureAgentTranscriptStart = () => {
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
      noticeTranscript:
        current.entry && sessionId
          ? {
              scope: {
                agentId: session.agentId,
                sessionId,
                sessionKey: session.sessionKey,
                storePath: current.storePath,
              },
              start: {
                sessionId,
                generation: watermark.generation,
                afterSeq: watermark.maxSeq ?? 0,
              },
              expectedSession: {
                sessionId: current.entry.sessionId,
                lifecycleRevision: current.entry.lifecycleRevision,
                activeWriterRunId: current.entry.activeWriterRunId,
                providerOverride: current.entry.providerOverride,
                modelOverride: current.entry.modelOverride,
              },
            }
          : undefined,
    };
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
  const ownsDispatchedRuntimeText = (payload: ReplyPayload): boolean => {
    const run = params.getReplyDispatchRun?.();
    return Boolean(
      run &&
      waitForModelPolicyNoticePublication(payload) !== undefined &&
      !payload.isError &&
      !payload.isReasoning &&
      !isReplyPayloadStatusNotice(payload) &&
      payload.text?.trim(),
    );
  };
  const needsAgentTranscriptFinalization = (payload: ReplyPayload): boolean => {
    const metadata = getReplyPayloadMetadata(payload);
    return (
      isMediaBearingPayload(payload) ||
      Boolean(metadata?.assistantMediaFailures?.length) ||
      ownsDispatchedRuntimeText(payload)
    );
  };
  const agentMediaTranscriptKey = (payload: ReplyPayload): string => {
    const metadata = getReplyPayloadMetadata(payload);
    if (metadata?.assistantTranscriptEntryId) {
      return `entry:${metadata.assistantTranscriptEntryId}`;
    }
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
  const finalizeWebchatAgentTranscriptIfNeeded = async (payload: ReplyPayload) => {
    if (!isAgentRunStarted() || !needsAgentTranscriptFinalization(payload)) {
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
    const dispatchOwnsRuntimeText = ownsDispatchedRuntimeText(payload);
    const payloadMetadata = getReplyPayloadMetadata(payload);
    const payloadHasTranscriptIdentity =
      payloadMetadata?.assistantTranscriptEntryId ||
      (payloadMetadata?.assistantTranscriptOwned &&
        payloadMetadata.assistantTranscriptIdempotencyKey);
    if (
      replyDispatchRun &&
      !transcript &&
      !payloadHasTranscriptIdentity &&
      !dispatchOwnsRuntimeText
    ) {
      logGateway.warn(
        "webchat runtime-owned media skipped: assistant transcript was not persisted",
      );
      return;
    }
    const sessionKey = transcript?.sessionKey ?? session.sessionKey;
    const agentId = transcript?.agentId ?? session.agentId;
    const ttsSupplementMarker = buildTtsSupplementTranscriptMarker(payload);
    const [transcriptPayload] = await normalizeWebchatReplyMediaPathsForDisplay({
      cfg,
      sessionKey,
      agentId,
      accountId,
      payloads: [stripVisibleTextFromTtsSupplement(payload)],
    });
    if (!transcriptPayload) {
      return;
    }
    const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(sessionKey, {
      ...sessionLoadOptions,
      ...(agentId ? { agentId } : {}),
    });
    const sessionId = latestEntry?.sessionId ?? backingSessionId ?? clientRunId;
    const mediaLocalRoots = appendLocalMediaParentRoots(
      getAgentScopedMediaLocalRoots(cfg, agentId),
      latestStorePath ? [latestStorePath] : undefined,
    );
    const mediaMessage = await buildWebchatAssistantMessageFromReplyPayloads([transcriptPayload], {
      localRoots: mediaLocalRoots,
      onLocalAudioAccessDenied: (err) => {
        logGateway.warn(`webchat audio embedding denied local path: ${formatForLog(err)}`);
      },
    });
    const { assistantContent, persistedAssistantContent } = await buildAssistantReplyContent({
      sessionKey,
      agentId,
      payloads: [transcriptPayload],
      transcriptMediaMessage: mediaMessage,
      managedMediaLocalRoots: mediaLocalRoots,
      includeSensitiveMedia: transcriptPayload.sensitiveMedia !== true,
      onManagedMediaPrepareError: (message) => {
        logGateway.warn(`webchat media embedding skipped attachment: ${message}`);
      },
    });
    const transcriptPayloadMetadata = getReplyPayloadMetadata(transcriptPayload);
    const mediaFailures = transcriptPayloadMetadata?.assistantMediaFailures ?? [];
    const mediaNormalizationFailed = mediaFailures.length > 0;
    const persistedContentForAppend =
      dispatchOwnsRuntimeText ||
      hasAssistantDisplayMediaContent(persistedAssistantContent) ||
      mediaNormalizationFailed
        ? persistedAssistantContent
        : undefined;
    if (!persistedContentForAppend?.length) {
      return;
    }
    const transcriptReply =
      mediaMessage?.transcriptText ??
      extractAssistantDisplayText(assistantContent) ??
      buildTranscriptReplyText([transcriptPayload]);
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
    if (
      (dispatchOwnsRuntimeText || payloadHasTranscriptIdentity) &&
      (assistantTranscriptRewriteState.sessionId !== sessionId ||
        loadSessionEntry(sessionKey, { ...sessionLoadOptions, agentId }).entry?.sessionId !==
          sessionId)
    ) {
      if (!dispatchOwnsRuntimeText) {
        logGateway.warn("webchat runtime-owned media skipped: transcript session changed");
        return;
      }
      throw new Error(
        "Reply could not be published: its session transcript changed. Please send your message again.",
      );
    }
    if (dispatchOwnsRuntimeText) {
      if (!transcriptScope || !latestEntry) {
        throw new Error(
          "Reply could not be published: its recovery notice has no current session. Please send your message again.",
        );
      }
      if (transcript?.messageId && !payloadMetadata?.assistantTranscriptEntryId) {
        setReplyPayloadMetadata(payload, { assistantTranscriptEntryId: transcript.messageId });
      }
      const rewritten = await persistModelNoticeTranscript(payload, {
        transcript: assistantTranscriptRewriteState.noticeTranscript,
        rewriteMessage: (message) =>
          buildAssistantDisplayRewrite({
            message,
            displayContent: persistedContentForAppend,
            managedMediaUrls: sourceMediaUrls,
          }),
      });
      if (!rewritten) {
        throw new Error(
          "Reply could not be published: its recovery notice has no current assistant transcript row. Please send your message again.",
        );
      }
      assistantTranscriptRewriteState.generation = rewritten.generation;
      appendedWebchatAgentMedia = true;
      setReplyPayloadMetadata(payload, { assistantTranscriptOwned: true });
      finalizedAgentMediaTranscriptKeys.add(finalizationKey);
      if (assistantContent?.length) {
        attachManagedOutgoingMediaToMessage({
          messageId: rewritten.messageId,
          blocks: assistantContent,
        });
      }
      return;
    }
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
    const assistantEntryId = payloadMetadata?.assistantTranscriptEntryId;
    const transcriptIdentity = assistantEntryId
      ? { kind: "entry" as const, id: assistantEntryId }
      : assistantMessageIndex !== undefined
        ? { kind: "stream" as const, index: assistantMessageIndex }
        : undefined;
    if (transcriptScope && transcriptIdentity) {
      if (assistantTranscriptRewriteState.sessionId !== sessionId) {
        assistantTranscriptRewriteState = {
          sessionId,
          generation: null,
          afterSeq: 0,
          noticeTranscript: undefined,
        };
      }
      const rewritten = await rewriteAssistantTranscriptMessageByTurnIdentity({
        afterSeq: assistantTranscriptRewriteState.afterSeq,
        identity: transcriptIdentity,
        expectedGeneration: assistantTranscriptRewriteState.generation,
        mediaUrls: sourceMediaUrls,
        rewriteMessage: (message) =>
          buildAssistantDisplayRewrite({
            message,
            displayContent: persistedContentForAppend,
            managedMediaUrls: sourceMediaUrls,
            ...(sourceMediaUrls.length > 0 ? { retainOriginalText: true as const } : {}),
          }),
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
    if (assistantEntryId) {
      logGateway.warn("webchat runtime-owned media skipped: transcript identity not found");
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
        (payloadMetadata?.assistantTranscriptEntryId ||
          (payloadMetadata?.assistantTranscriptOwned &&
            payloadMetadata.assistantTranscriptIdempotencyKey)) &&
        !payloadMetadata.sessionWriterDeliveryAuthority &&
        assistantTranscriptRewriteState.sessionId
      ) {
        setReplyPayloadMetadata(payload, {
          sessionWriterDeliveryAuthority: {
            agentId: session.agentId,
            sessionKey: session.sessionKey,
            expectedSessionId: assistantTranscriptRewriteState.sessionId,
          },
        });
      }
      if (
        payloadMetadata?.beforeAgentRunBlocked === true ||
        payloadMetadata?.sourceReplyTranscriptMirror?.transcriptWriteBlocked === true
      ) {
        userTurnRecorder.markBlocked();
      }
      switch (info.kind) {
        case "block":
        case "final":
          deferModelPolicyNoticeAcknowledgment(payload);
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
  const finalizeAgentTranscript = async () => {
    const latestPayloadByKey = new Map<string, ReplyPayload>();
    for (const { payload } of deliveredReplies) {
      if (!needsAgentTranscriptFinalization(payload)) {
        continue;
      }
      latestPayloadByKey.set(agentMediaTranscriptKey(payload), payload);
    }
    for (const payload of latestPayloadByKey.values()) {
      try {
        await finalizeWebchatAgentTranscriptIfNeeded(payload);
      } catch (error) {
        if (ownsDispatchedRuntimeText(payload)) {
          throw error;
        }
        logGateway.warn(`webchat media finalization failed: ${formatForLog(error)}`);
      }
    }
  };
  const runAgentTranscript = async <T>(
    admission: { run: (operation: () => Promise<T>) => Promise<T> },
    operation: () => Promise<T>,
  ): Promise<T> => {
    return await admission.run(async () => {
      preparingTranscript = true;
      try {
        return await operation();
      } finally {
        preparingTranscript = false;
        // Stay inside the session admission after the runtime owner unwinds; callers chain
        // post-dispatch persistence from this Promise, and finalizer errors stay best-effort.
        await finalizeAgentTranscript();
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
    runAgentTranscript,
    releasePendingPolicyNoticePublications: async () => {
      for (const { payload } of deliveredReplies) {
        await settleModelPolicyNoticePublication(payload, false);
      }
    },
  };
}
