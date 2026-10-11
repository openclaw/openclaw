import {
  getReplyPayloadMetadata,
  isReplyPayloadStatusNotice,
} from "../../auto-reply/reply-payload.js";
import type { QueuedFollowupReplyBatch } from "../../auto-reply/reply/queue/types.js";
import type { ReplyDispatchOperation } from "../../auto-reply/reply/reply-dispatcher.types.js";
import {
  readTranscriptEventId,
  readTranscriptEventMessage,
} from "../../config/sessions/session-accessor.sqlite-read.js";
import { readSessionTranscriptAnchorsAsync } from "../../config/sessions/session-transcript-anchor-read.js";
import { findTranscriptEvent } from "../../config/sessions/session-transcript-match.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { readAssistantDisplayContent } from "../../shared/assistant-display-content.js";
import { appendChatCanvasBlocksToMessage } from "../chat-display-projection.canvas.js";
import { attachManagedOutgoingMediaToMessage } from "../managed-image-attachments.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "../session-utils-store-worker.js";
import {
  extractAssistantDisplayText,
  hasAssistantDisplayMediaContent,
  hasManagedOutgoingAssistantContent,
  hasVisibleAssistantFinalMessage,
  stripManagedOutgoingAssistantContentBlocks,
  type AssistantDisplayContentBlock,
} from "./chat-assistant-content.js";
import {
  broadcastChatDelta,
  broadcastChatFinal,
  broadcastChatTerminal,
  isSourceReplyTranscriptMirrorPayload,
} from "./chat-broadcast.js";
import { withPreparedWebchatReplyMedia } from "./chat-reply-media.js";
import {
  buildTranscriptReplyTextFromInputs,
  readChatSendReplyPayload,
  type DeliveredChatSendReply,
} from "./chat-send-command-replies.js";
import {
  createChatSendReplyFinalizationAuthority,
  type ChatSendReplyFinalizationParams,
} from "./chat-send-delivery-authority.js";
import {
  assistantTranscriptScope,
  publishAssistantTranscriptRewrite,
  rewriteSourceReplyTranscriptMirrors,
  type SourceReplyContentState,
  type SourceReplyTranscriptMirror,
  type SourceReplyTranscriptRewrite,
} from "./chat-transcript-persistence.js";

function selectChatSendAgentReplyInputs(params: {
  deliveredReplies: readonly DeliveredChatSendReply[];
  hasReturnedAgentErrorPayloads: boolean;
}): ReplyDispatchOperation[] {
  return params.deliveredReplies
    .filter((entry) => {
      const payload = readChatSendReplyPayload(entry.input);
      return getReplyPayloadMetadata(payload)?.sessionWriterDeliveryAuthority ||
        isSourceReplyTranscriptMirrorPayload(payload)
        ? entry.kind === "final" && payload.isError !== true
        : !params.hasReturnedAgentErrorPayloads && isReplyPayloadStatusNotice(payload);
    })
    .map((entry) => entry.input);
}

type ChatSendAgentReplyFinalization =
  | { kind: "delivered"; hasSourceReplyTranscriptMirror: boolean }
  | { kind: "dropped"; reason: "no-visible-content" };

export function createChatSendLateReplyFinalizer(
  params: Omit<ChatSendReplyFinalizationParams, "emitFirstAssistantServerTiming">,
) {
  return async ({
    runId: runtimeRunId,
    clientRunId: runId,
    payloads,
    completion,
    isCurrent,
  }: Pick<QueuedFollowupReplyBatch, "runId" | "payloads" | "completion"> & {
    clientRunId: string;
    isCurrent: () => boolean;
  }): Promise<ChatSendAgentReplyFinalization> => {
    const { context, session } = params;
    const broadcastParams = {
      // Recovery uses its new run's lifecycle owner, not the original source admission.
      terminalEntry: runId === session.clientRunId ? params.terminalEntry : undefined,
      context,
      runId,
      sessionKey: session.sessionKey,
      agentId: session.agentId,
    };
    const terminal = completion.kind !== "progress";
    let publicationStarted = false;
    try {
      const result = await finalizeChatSendAgentReplyPayloads({
        ...params,
        emitFirstAssistantServerTiming: () => {},
        inputs: payloads.map((payload) => ({ kind: "raw", payload })),
        isCurrent,
        session: { ...session, clientRunId: runId },
        suppressFinal: completion.kind === "failed" || completion.kind === "aborted",
        publishMessage: (message, deliveryAuthorized) => {
          publicationStarted = true;
          if (completion.kind === "progress") {
            const text = typeof message.text === "string" ? message.text : undefined;
            if (text) {
              const run = context.chatRunState.getOrCreate(runId);
              broadcastChatDelta({
                ...broadcastParams,
                text,
                isCurrent: () =>
                  context.chatRunState.runs.get(runId) === run && deliveryAuthorized(),
              });
            }
          } else {
            const run = context.chatRunState.runs.get(runId);
            broadcastChatTerminal({
              ...broadcastParams,
              state: "final",
              message:
                run?.bufferIsCurrent?.() === false
                  ? message
                  : appendChatCanvasBlocksToMessage(message, run?.canvasBlocks ?? []),
              stopReason: completion.stopReason,
            });
          }
        },
      });
      if (!isCurrent()) {
        return { kind: "dropped", reason: "no-visible-content" };
      }
      if (
        completion.kind === "failed" ||
        completion.kind === "aborted" ||
        (terminal && result.kind === "dropped")
      ) {
        const buffered = context.chatRunState.resolveBuffer(runId, { final: true });
        const run = context.chatRunState.runs.get(runId);
        const canvas = run?.bufferIsCurrent?.() === false ? [] : (run?.canvasBlocks ?? []);
        const canvasOnly =
          completion.kind === "completed" &&
          completion.allowCanvasOnly === true &&
          payloads.length === 0 &&
          canvas.length > 0 &&
          !(run?.rawBuffer ?? run?.buffer ?? "").trim();
        if (completion.kind === "failed" || completion.kind === "aborted") {
          context.chatRunState.flushPendingText(runId);
        }
        publicationStarted = true;
        broadcastChatTerminal({
          ...broadcastParams,
          stopReason: completion.stopReason,
          ...(completion.kind === "failed"
            ? { state: "error", errorMessage: completion.error, errorKind: completion.errorKind }
            : {
                state: completion.kind === "aborted" ? "aborted" : "final",
                ...((completion.kind === "aborted" && buffered.text && !buffered.suppress) ||
                canvasOnly
                  ? {
                      message: appendChatCanvasBlocksToMessage(
                        {
                          role: "assistant",
                          content: canvasOnly ? [] : [{ type: "text", text: buffered.text }],
                          timestamp: Date.now(),
                        },
                        canvas,
                      ),
                    }
                  : {}),
              }),
        });
      }
      return terminal
        ? {
            kind: "delivered",
            hasSourceReplyTranscriptMirror:
              result.kind === "delivered" && result.hasSourceReplyTranscriptMirror,
          }
        : result;
    } catch (error) {
      // Preparation failure can still complete the run. An uncertain broadcast cannot be replayed.
      if (terminal && !publicationStarted && isCurrent()) {
        context.chatRunState.flushPendingText(runId);
        broadcastChatTerminal({
          ...broadcastParams,
          state: "error",
          errorMessage: formatErrorMessage(error),
        });
      }
      throw error;
    } finally {
      if (terminal) {
        context.removeChatRun(runtimeRunId, runId, session.sessionKey);
        if (isCurrent()) {
          context.chatRunState.clearRun(runId);
          context.agentRunSeq.delete(runId);
        }
        context.agentRunSeq.delete(runtimeRunId);
      }
    }
  };
}

async function finalizeChatSendAgentReplyPayloads(
  params: ChatSendReplyFinalizationParams & {
    inputs: readonly ReplyDispatchOperation[];
    suppressFinal?: boolean;
    publishMessage?: (message: Record<string, unknown>, deliveryAuthorized: () => boolean) => void;
    isCurrent?: () => boolean;
  },
): Promise<ChatSendAgentReplyFinalization> {
  const { context, emitFirstAssistantServerTiming, session } = params;
  const { agentId, backingSessionId, clientRunId, sessionKey, sessionLoadOptions } = session;
  const agentRunReplyPayloads = params.inputs.map(readChatSendReplyPayload);
  if (agentRunReplyPayloads.length === 0) {
    return { kind: "dropped", reason: "no-visible-content" };
  }
  const { deliveryAuthorized, authorizeDelivery, captureMediaScope } =
    createChatSendReplyFinalizationAuthority(params, agentRunReplyPayloads);
  if (!authorizeDelivery("finalization")) {
    return { kind: "dropped", reason: "no-visible-content" };
  }

  const hasSourceReplyTranscriptMirror = agentRunReplyPayloads.some(
    isSourceReplyTranscriptMirrorPayload,
  );
  const mediaScope = captureMediaScope();
  const { storePath: latestStorePath, entry: latestEntry } =
    await loadGatewaySessionEntryReadOnlyInWorker({
      cfg: context.getRuntimeConfig(),
      key: sessionKey,
      ...sessionLoadOptions,
      projection: [],
    });
  if (!authorizeDelivery("session preparation")) {
    return { kind: "dropped", reason: "no-visible-content" };
  }
  const sessionId = latestEntry?.sessionId ?? backingSessionId ?? clientRunId;
  const sourceReplyScope = assistantTranscriptScope({
    sessionId,
    sessionKey,
    storePath: latestStorePath,
    agentId,
  });
  const committedSourceContent = await Promise.all(
    agentRunReplyPayloads.map(async (payload) => {
      const mirror = getReplyPayloadMetadata(payload)?.sourceReplyTranscriptMirror;
      if (!sourceReplyScope || !mirror?.transcriptOwner || !mirror.idempotencyKey) {
        return undefined;
      }
      const found = await findTranscriptEvent(sourceReplyScope, {
        kind: "idempotency",
        key: mirror.idempotencyKey,
        deliveryMirror: true,
      });
      mediaScope.assertCurrent();
      const messageId = found && readTranscriptEventId(found.event);
      if (!messageId) {
        return undefined;
      }
      const { anchors } = await readSessionTranscriptAnchorsAsync(
        { ...sourceReplyScope, sessionKey },
        { entryIds: [messageId] },
        params.abortSignal,
      );
      mediaScope.assertCurrent();
      const content = readAssistantDisplayContent(readTranscriptEventMessage(found.event));
      return anchors.length > 0 && content.length > 0 ? content : undefined;
    }),
  );
  mediaScope.assertCurrent();
  const { finalInputsByIndex, sourceReplyContentStates, sourceReplyBroadcastContent } =
    await withPreparedWebchatReplyMedia(
      {
        scope: mediaScope,
        storePath: latestStorePath,
        inputs: params.inputs.filter((_, index) => !committedSourceContent[index]),
        abortSignal: params.abortSignal,
        includeSensitiveMedia: false,
        logGateway: context.logGateway,
      },
      async ({ payloads: normalizedPayloads, inputsByIndex, buildContent }) => {
        const contentStates: SourceReplyContentState[] = [];
        const broadcastContent: AssistantDisplayContentBlock[] = [];
        let preparedIndex = 0;
        for (const [replyIndex] of agentRunReplyPayloads.entries()) {
          const committedContent = committedSourceContent[replyIndex];
          if (committedContent) {
            // The message tool committed media before its result and later model output.
            // Consume that display without restaging it or rewriting the transcript tail.
            contentStates[replyIndex] = {
              broadcastContent: committedContent,
              persistedContent: committedContent,
              hasManagedOutgoingContent: hasManagedOutgoingAssistantContent(committedContent),
              backedManagedOutgoingContent: true,
            };
            broadcastContent.push(...committedContent);
            continue;
          }
          const inputIndex = preparedIndex++;
          const finalPayload = normalizedPayloads[inputIndex];
          if (!finalPayload) {
            continue;
          }
          const {
            persistedAssistantContent: persistedContent,
            broadcastContent: replyBroadcastContent,
          } = await buildContent(inputsByIndex[inputIndex] ?? []);
          const state: SourceReplyContentState = {
            broadcastContent: replyBroadcastContent ? [...replyBroadcastContent] : [],
            persistedContent: persistedContent ? [...persistedContent] : [],
            hasManagedOutgoingContent: hasManagedOutgoingAssistantContent(persistedContent),
            backedManagedOutgoingContent: false,
          };
          contentStates[replyIndex] = state;
          broadcastContent.push(...state.broadcastContent);
        }
        return {
          finalInputsByIndex: inputsByIndex,
          sourceReplyContentStates: contentStates,
          sourceReplyBroadcastContent: broadcastContent,
        };
      },
    );

  const displayReply =
    extractAssistantDisplayText(sourceReplyBroadcastContent) ??
    buildTranscriptReplyTextFromInputs(finalInputsByIndex.flat());
  if (!sourceReplyBroadcastContent.length && !displayReply) {
    return { kind: "dropped", reason: "no-visible-content" };
  }

  const sourceReplyPersistenceRequests: SourceReplyTranscriptRewrite[] = [];
  const sourceReplyMirrorCandidates: SourceReplyTranscriptMirror[] = [];
  for (const [replyIndex, sourceReplyPayload] of agentRunReplyPayloads.entries()) {
    const state = sourceReplyContentStates[replyIndex];
    if (!state) {
      continue;
    }
    const mirrorMetadata = getReplyPayloadMetadata(sourceReplyPayload)?.sourceReplyTranscriptMirror;
    const mirrorIdempotencyKey = mirrorMetadata?.idempotencyKey;
    if (
      typeof mirrorIdempotencyKey !== "string" ||
      mirrorIdempotencyKey.trim().length === 0 ||
      !mirrorMetadata
    ) {
      continue;
    }
    const candidate = {
      idempotencyKey: mirrorIdempotencyKey,
      metadata: mirrorMetadata,
    };
    sourceReplyMirrorCandidates.push(candidate);
    if (
      !state.backedManagedOutgoingContent &&
      hasAssistantDisplayMediaContent(state.persistedContent)
    ) {
      if (!state.hasManagedOutgoingContent) {
        state.backedManagedOutgoingContent = true;
      }
      sourceReplyPersistenceRequests.push({ ...candidate, state });
    }
  }

  if (!authorizeDelivery("transcript finalization")) {
    return { kind: "dropped", reason: "no-visible-content" };
  }
  if (sourceReplyScope && sourceReplyPersistenceRequests.length > 0) {
    const rewritten = await rewriteSourceReplyTranscriptMirrors({
      candidates: sourceReplyMirrorCandidates,
      requests: sourceReplyPersistenceRequests,
      scope: sourceReplyScope,
    });
    if (rewritten.length > 0) {
      for (const target of rewritten) {
        const state = target.request.state;
        if (state.hasManagedOutgoingContent) {
          await attachManagedOutgoingMediaToMessage({
            messageId: target.messageId,
            blocks: state.persistedContent,
          });
        }
        state.backedManagedOutgoingContent = true;
      }
      await publishAssistantTranscriptRewrite({
        scope: sourceReplyScope,
        rewritten,
      });
    }
  }
  const sourceReplyContent = sourceReplyContentStates.flatMap((state) => {
    if (state.hasManagedOutgoingContent && !state.backedManagedOutgoingContent) {
      return (
        stripManagedOutgoingAssistantContentBlocks(state.broadcastContent) ?? [
          { type: "text", text: "Media reply could not be displayed." },
        ]
      );
    }
    return state.broadcastContent;
  });
  const sourceReplyTextFromContent = extractAssistantDisplayText(sourceReplyContent);
  const sourceReplyText =
    sourceReplyTextFromContent ?? (sourceReplyContent.length === 0 ? displayReply : undefined);
  const message = {
    role: "assistant",
    ...(sourceReplyContent.length
      ? { content: sourceReplyContent }
      : sourceReplyText
        ? { content: [{ type: "text", text: sourceReplyText }] }
        : {}),
    ...(sourceReplyText ? { text: sourceReplyText } : {}),
    timestamp: Date.now(),
    stopReason: "stop",
    usage: { input: 0, output: 0, totalTokens: 0 },
  };
  // Failed turns retain source media/transcript finalization; chat.error carries no message.
  if (!params.suppressFinal) {
    if (!authorizeDelivery("broadcast")) {
      return { kind: "dropped", reason: "no-visible-content" };
    }
    if (hasVisibleAssistantFinalMessage(message)) {
      emitFirstAssistantServerTiming();
    }
    if (params.publishMessage) {
      params.publishMessage(message, deliveryAuthorized);
    } else {
      broadcastChatFinal({
        terminalEntry: params.terminalEntry,
        context,
        runId: clientRunId,
        sessionKey,
        agentId,
        message,
      });
    }
  }
  return { kind: "delivered", hasSourceReplyTranscriptMirror };
}

/** Persist and broadcast agent-run source/status replies that bypass the normal model turn. */
export async function finalizeChatSendSourceReplies(
  params: ChatSendReplyFinalizationParams & {
    deliveredReplies: readonly DeliveredChatSendReply[];
    hasReturnedAgentErrorPayloads: boolean;
    suppressFinal?: boolean;
  },
): Promise<boolean> {
  const result = await finalizeChatSendAgentReplyPayloads({
    ...params,
    inputs: selectChatSendAgentReplyInputs(params),
  });
  return result.kind === "delivered" && result.hasSourceReplyTranscriptMirror;
}
