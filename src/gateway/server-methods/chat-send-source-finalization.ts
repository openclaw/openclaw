import {
  getReplyPayloadMetadata,
  isReplyPayloadStatusNotice,
} from "../../auto-reply/reply-payload.js";
import type { QueuedFollowupReplyBatch } from "../../auto-reply/reply/queue/types.js";
import type { ReplyDispatchOperation } from "../../auto-reply/reply/reply-dispatcher.types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { appendChatCanvasBlocksToMessage } from "../chat-display-projection.canvas.js";
import { attachManagedOutgoingMediaToMessage } from "../managed-image-attachments.js";
import { loadSessionEntry } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
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
import {
  captureWebchatReplyMediaScope,
  withPreparedWebchatReplyMedia,
  type WebchatReplyMediaRequesterContext,
} from "./chat-reply-media.js";
import {
  buildTranscriptReplyTextFromInputs,
  readChatSendReplyPayload,
  type DeliveredChatSendReply,
} from "./chat-send-command-replies.js";
import { isChatSendReplyDeliveryAuthorized } from "./chat-send-delivery-authority.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import {
  assistantTranscriptScope,
  publishAssistantTranscriptRewrite,
  rewriteSourceReplyTranscriptMirrors,
  type SourceReplyContentState,
  type SourceReplyTranscriptMirrorMetadata,
} from "./chat-transcript-persistence.js";
import type { GatewayRequestContext } from "./types.js";

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

type FinalizeChatSendAgentRepliesBase = {
  resolveReplyInputs?: (input: ReplyDispatchOperation, runId?: string) => ReplyDispatchOperation[];
  requesterContext?: WebchatReplyMediaRequesterContext;
  abortSignal?: AbortSignal;
  accountId: string | undefined;
  context: GatewayRequestContext;
  emitFirstAssistantServerTiming: () => void;
  session: Pick<
    PreparedChatSendSession,
    "agentId" | "backingSessionId" | "cfg" | "clientRunId" | "sessionKey" | "sessionLoadOptions"
  >;
};

type ChatSendAgentReplyFinalization =
  | { kind: "delivered"; hasSourceReplyTranscriptMirror: boolean }
  | { kind: "dropped"; reason: "no-visible-content" };

export function createChatSendLateReplyFinalizer(
  params: Omit<FinalizeChatSendAgentRepliesBase, "emitFirstAssistantServerTiming">,
) {
  return async ({
    runId,
    payloads,
    completion,
    isCurrent,
  }: Pick<QueuedFollowupReplyBatch, "runId" | "payloads" | "completion"> & {
    isCurrent: () => boolean;
  }): Promise<ChatSendAgentReplyFinalization> => {
    const { context, session } = params;
    const broadcastParams = {
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
      if (terminal && !publicationStarted) {
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
        context.removeChatRun(runId, runId, session.sessionKey);
        context.chatRunState.clearRun(runId);
        context.agentRunSeq.delete(runId);
      }
    }
  };
}

async function finalizeChatSendAgentReplyPayloads(
  params: FinalizeChatSendAgentRepliesBase & {
    inputs: readonly ReplyDispatchOperation[];
    suppressFinal?: boolean;
    publishMessage?: (message: Record<string, unknown>, deliveryAuthorized: () => boolean) => void;
    isCurrent?: () => boolean;
  },
): Promise<ChatSendAgentReplyFinalization> {
  const { accountId, context, emitFirstAssistantServerTiming, session } = params;
  const { agentId, backingSessionId, cfg, clientRunId, sessionKey, sessionLoadOptions } = session;
  const replyInputs = params.inputs.flatMap(
    (input) => params.resolveReplyInputs?.(input, clientRunId) ?? [input],
  );
  const agentRunReplyPayloads = replyInputs.map(readChatSendReplyPayload);
  if (agentRunReplyPayloads.length === 0) {
    return { kind: "dropped", reason: "no-visible-content" };
  }
  const deliveryAuthorized = () =>
    (!params.isCurrent || params.isCurrent()) &&
    agentRunReplyPayloads.every((payload) =>
      isChatSendReplyDeliveryAuthorized({ agentId, payload, sessionLoadOptions }),
    );
  if (!deliveryAuthorized()) {
    context.logGateway.warn(
      "webchat settled final reply skipped: session writer changed before finalization",
    );
    return { kind: "dropped", reason: "no-visible-content" };
  }

  const hasSourceReplyTranscriptMirror = agentRunReplyPayloads.some(
    isSourceReplyTranscriptMirrorPayload,
  );
  const mediaScope = captureWebchatReplyMediaScope({
    requesterContext: params.requesterContext,
    cfg,
    sessionKey,
    agentId,
    sessionLoadOptions,
    accountId,
    assertCurrent: () => {
      if (!deliveryAuthorized()) {
        throw new Error("Chat media delivery is no longer authorized.");
      }
    },
  });
  const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(
    sessionKey,
    sessionLoadOptions,
  );
  const sessionId = latestEntry?.sessionId ?? backingSessionId ?? clientRunId;
  const { finalInputsByIndex, sourceReplyContentStates, sourceReplyBroadcastContent } =
    await withPreparedWebchatReplyMedia(
      {
        scope: mediaScope,
        storePath: latestStorePath,
        inputs: replyInputs,
        abortSignal: params.abortSignal,
        includeSensitiveMedia: false,
        onLocalAudioAccessDenied: (err) => {
          context.logGateway.warn(
            `webchat audio embedding denied local path: ${formatForLog(err)}`,
          );
        },
        onManagedMediaPrepareError: (message) => {
          context.logGateway.warn(`webchat media embedding skipped attachment: ${message}`);
        },
      },
      async ({ payloads: normalizedPayloads, inputsByIndex, buildContent }) => {
        const contentStates: SourceReplyContentState[] = [];
        const broadcastContent: AssistantDisplayContentBlock[] = [];
        for (const [replyIndex] of agentRunReplyPayloads.entries()) {
          const finalPayload = normalizedPayloads[replyIndex];
          if (!finalPayload) {
            continue;
          }
          const {
            assistantContent: replyAssistantContent,
            persistedAssistantContent: persistedContent,
            mediaMessage: replyMediaMessage,
          } = await buildContent(inputsByIndex[replyIndex] ?? []);
          const replyBroadcastContent = hasAssistantDisplayMediaContent(replyAssistantContent)
            ? replyAssistantContent
            : hasAssistantDisplayMediaContent(replyMediaMessage?.content)
              ? replyMediaMessage?.content
              : replyAssistantContent;
          const state: SourceReplyContentState = {
            broadcastContent: replyBroadcastContent ? [...replyBroadcastContent] : [],
            persistedContent: persistedContent ? [...persistedContent] : [],
            hasManagedOutgoingContent: hasManagedOutgoingAssistantContent(persistedContent),
            backedManagedOutgoingContent: false,
          };
          contentStates[replyIndex] = state;
          if (state.broadcastContent.length > 0) {
            broadcastContent.push(...state.broadcastContent);
          }
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

  const sourceReplyPersistenceRequests: Array<{
    idempotencyKey: string;
    metadata: SourceReplyTranscriptMirrorMetadata;
    state: SourceReplyContentState;
  }> = [];
  const sourceReplyMirrorCandidates: Array<{
    idempotencyKey: string;
    metadata: SourceReplyTranscriptMirrorMetadata;
  }> = [];
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
    if (hasAssistantDisplayMediaContent(state.persistedContent)) {
      if (!state.hasManagedOutgoingContent) {
        state.backedManagedOutgoingContent = true;
      }
      sourceReplyPersistenceRequests.push({ ...candidate, state });
    }
  }

  const attachSourceReplyManagedImages = async (attachParams: {
    messageId?: string;
    request: (typeof sourceReplyPersistenceRequests)[number];
  }) => {
    if (!attachParams.request.state.hasManagedOutgoingContent) {
      attachParams.request.state.backedManagedOutgoingContent = true;
      return;
    }
    if (!attachParams.messageId) {
      return;
    }
    attachManagedOutgoingMediaToMessage({
      messageId: attachParams.messageId,
      blocks: attachParams.request.state.persistedContent,
    });
    attachParams.request.state.backedManagedOutgoingContent = true;
  };

  const sourceReplyScope = assistantTranscriptScope({
    sessionId,
    sessionKey,
    storePath: latestStorePath,
    agentId,
  });
  if (!deliveryAuthorized()) {
    context.logGateway.warn(
      "webchat settled final reply skipped: session writer changed before transcript finalization",
    );
    return { kind: "dropped", reason: "no-visible-content" };
  }
  if (sourceReplyScope && sourceReplyPersistenceRequests.length > 0) {
    const rewritten = await rewriteSourceReplyTranscriptMirrors({
      candidates: sourceReplyMirrorCandidates,
      requests: sourceReplyPersistenceRequests,
      scope: sourceReplyScope,
    });
    if (rewritten.length > 0) {
      await publishAssistantTranscriptRewrite({
        scope: sourceReplyScope,
        rewritten,
      });
      for (const target of rewritten) {
        await attachSourceReplyManagedImages({
          messageId: target.messageId,
          request: target.request,
        });
      }
    }
  }
  const sourceReplyContent = sourceReplyContentStates
    .flatMap((state) => {
      if (state.hasManagedOutgoingContent && !state.backedManagedOutgoingContent) {
        const stripped = stripManagedOutgoingAssistantContentBlocks(state.broadcastContent);
        return stripped?.length
          ? stripped
          : [{ type: "text", text: "Media reply could not be displayed." }];
      }
      return state.broadcastContent;
    })
    .filter((block): block is AssistantDisplayContentBlock => Boolean(block));
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
    if (!deliveryAuthorized()) {
      context.logGateway.warn(
        "webchat settled final reply skipped: session writer changed before broadcast",
      );
      return { kind: "dropped", reason: "no-visible-content" };
    }
    if (hasVisibleAssistantFinalMessage(message)) {
      emitFirstAssistantServerTiming();
    }
    if (params.publishMessage) {
      params.publishMessage(message, deliveryAuthorized);
    } else {
      broadcastChatFinal({
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
  params: FinalizeChatSendAgentRepliesBase & {
    deliveredReplies: readonly DeliveredChatSendReply[];
    hasReturnedAgentErrorPayloads: boolean;
    suppressFinal?: boolean;
  },
): Promise<boolean> {
  const result = await finalizeChatSendAgentReplyPayloads({
    requesterContext: params.requesterContext,
    abortSignal: params.abortSignal,
    accountId: params.accountId,
    context: params.context,
    emitFirstAssistantServerTiming: params.emitFirstAssistantServerTiming,
    inputs: selectChatSendAgentReplyInputs(params),
    resolveReplyInputs: params.resolveReplyInputs,
    session: params.session,
    suppressFinal: params.suppressFinal,
  });
  return result.kind === "delivered" && result.hasSourceReplyTranscriptMirror;
}
