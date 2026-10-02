import {
  getReplyPayloadMetadata,
  isReplyPayloadStatusNotice,
} from "../../auto-reply/reply-payload.js";
import type { QueuedFollowupReplyBatch } from "../../auto-reply/reply/queue/types.js";
import type { ReplyDispatchOperation } from "../../auto-reply/reply/reply-dispatcher.types.js";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
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
  readChatSendReplyPayload,
  type DeliveredChatSendReply,
} from "./chat-send-command-replies.js";
import { isChatSendReplyDeliveryAuthorized } from "./chat-send-delivery-authority.js";
import { buildTranscriptReplyTextFromInputs } from "./chat-send-reply-dispatch.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import {
  appendAssistantTranscriptMessage,
  assistantTranscriptScope,
  publishAssistantTranscriptRewrite,
  rewriteSourceReplyTranscriptMirrors,
  type SourceReplyContentState,
  type SourceReplyTranscriptMirror,
  type SourceReplyTranscriptRewrite,
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
        getReplyPayloadMetadata(payload)?.continuationStatus ||
        isSourceReplyTranscriptMirrorPayload(payload)
        ? entry.kind === "final" && payload.isError !== true
        : !params.hasReturnedAgentErrorPayloads && isReplyPayloadStatusNotice(payload);
    })
    .map((entry) => entry.input);
}

type FinalizeChatSendAgentRepliesBase = {
  requesterContext?: WebchatReplyMediaRequesterContext;
  abortSignal?: AbortSignal;
  isCurrent?: () => boolean;
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

type FinalizeChatSendAgentReplyPayloads = FinalizeChatSendAgentRepliesBase & {
  inputs: readonly ReplyDispatchOperation[];
  suppressFinal?: boolean;
  publishMessage?: (message: Record<string, unknown>, deliveryAuthorized: () => boolean) => void;
};

async function finalizeChatSendAgentReplyPayloads(
  params: FinalizeChatSendAgentReplyPayloads,
): Promise<ChatSendAgentReplyFinalization> {
  // A durable waiting acknowledgment has its own message identity. Never publish
  // neighboring status text under that identity or repeat it in an unkeyed aggregate.
  const statusInputs: ReplyDispatchOperation[] = [];
  const continuationInputs: ReplyDispatchOperation[][] = [];
  for (const input of params.inputs) {
    if (getReplyPayloadMetadata(readChatSendReplyPayload(input))?.continuationStatus) {
      continuationInputs.push([input]);
    } else {
      statusInputs.push(input);
    }
  }
  const messages: { message: Record<string, unknown>; deliveryAuthorized: () => boolean }[] = [];
  let result: ChatSendAgentReplyFinalization = { kind: "dropped", reason: "no-visible-content" };
  for (const inputs of [statusInputs, ...continuationInputs]) {
    if (inputs.length === 0) {
      continue;
    }
    const next = await finalizeChatSendAgentReplyPayloadGroup({
      ...params,
      inputs,
      publishMessage: (message, deliveryAuthorized) =>
        messages.push({ message, deliveryAuthorized }),
    });
    if (next.kind === "delivered") {
      result = {
        kind: "delivered",
        hasSourceReplyTranscriptMirror:
          next.hasSourceReplyTranscriptMirror ||
          (result.kind === "delivered" && result.hasSourceReplyTranscriptMirror),
      };
    }
  }
  // Finish required storage for every group before beginning live publication.
  // A later append failure must not masquerade as an uncertain earlier broadcast.
  if (messages.some(({ deliveryAuthorized }) => !deliveryAuthorized())) {
    return { kind: "dropped", reason: "no-visible-content" };
  }
  for (const { message, deliveryAuthorized } of messages) {
    if (hasVisibleAssistantFinalMessage(message)) {
      params.emitFirstAssistantServerTiming();
    }
    if (params.publishMessage) {
      params.publishMessage(message, deliveryAuthorized);
    } else {
      broadcastChatFinal({
        context: params.context,
        runId: params.session.clientRunId,
        sessionKey: params.session.sessionKey,
        agentId: params.session.agentId,
        message,
      });
    }
  }
  return result;
}

async function finalizeChatSendAgentReplyPayloadGroup(
  params: FinalizeChatSendAgentReplyPayloads & {
    publishMessage: NonNullable<FinalizeChatSendAgentReplyPayloads["publishMessage"]>;
  },
): Promise<ChatSendAgentReplyFinalization> {
  const { accountId, context, session } = params;
  const { agentId, backingSessionId, cfg, clientRunId, sessionKey, sessionLoadOptions } = session;
  const agentRunReplyPayloads = params.inputs.map(readChatSendReplyPayload);
  if (agentRunReplyPayloads.length === 0) {
    return { kind: "dropped", reason: "no-visible-content" };
  }
  const deliveryAuthorized = () =>
    (!params.isCurrent || params.isCurrent()) &&
    agentRunReplyPayloads.every((payload) =>
      isChatSendReplyDeliveryAuthorized({ agentId, payload, sessionLoadOptions }),
    );
  const authorizeDelivery = (stage: string) => {
    if (deliveryAuthorized()) {
      return true;
    }
    context.logGateway.warn(
      `webchat settled final reply skipped: session writer changed before ${stage}`,
    );
    return false;
  };
  if (!authorizeDelivery("finalization")) {
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
  const expectedLifecycleRevision = latestEntry?.lifecycleRevision;
  const { finalInputsByIndex, sourceReplyContentStates, sourceReplyBroadcastContent } =
    await withPreparedWebchatReplyMedia(
      {
        scope: mediaScope,
        storePath: latestStorePath,
        inputs: params.inputs,
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
    if (hasAssistantDisplayMediaContent(state.persistedContent)) {
      if (!state.hasManagedOutgoingContent) {
        state.backedManagedOutgoingContent = true;
      }
      sourceReplyPersistenceRequests.push({ ...candidate, state });
    }
  }

  const sourceReplyScope = assistantTranscriptScope({
    sessionId,
    sessionKey,
    storePath: latestStorePath,
    agentId,
  });
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
  // Waiting replies are authored after the model turn, so no runtime transcript row owns
  // them. Persist only that public payload, not tool results or neighboring progress notices.
  let continuationMessage: Record<string, unknown> | undefined;
  if (!params.suppressFinal && sourceReplyScope) {
    for (const [replyIndex, payload] of agentRunReplyPayloads.entries()) {
      const metadata = getReplyPayloadMetadata(payload);
      const state = sourceReplyContentStates[replyIndex];
      if (
        !metadata?.continuationStatus ||
        metadata.assistantTranscriptOwned ||
        metadata.sourceReplyTranscriptMirror ||
        !state?.persistedContent.length
      ) {
        continue;
      }
      const appended = await withSessionTranscriptWriteAssertion(
        sourceReplyScope,
        () => {
          params.abortSignal?.throwIfAborted();
          if (!deliveryAuthorized()) {
            throw new Error("Waiting reply delivery is no longer authorized.");
          }
        },
        () =>
          appendAssistantTranscriptMessage({
            sessionKey,
            sessionId,
            agentId,
            storePath: latestStorePath,
            expectedSessionId: backingSessionId ?? sessionId,
            expectedLifecycleRevision,
            message: buildTranscriptReplyTextFromInputs(finalInputsByIndex[replyIndex] ?? []),
            content: state.persistedContent,
            createIfMissing: true,
            idempotencyKey: `${clientRunId}:continuation-status`,
            cfg,
            onMessageCommitted: (receipt, acceptCompletion) => {
              if (state.hasManagedOutgoingContent) {
                acceptCompletion(async () => {
                  await attachManagedOutgoingMediaToMessage({
                    messageId: receipt.messageId,
                    blocks: state.persistedContent,
                  });
                });
              }
            },
          }),
      );
      if (!appended.ok) {
        throw new Error(
          `Waiting reply transcript append failed: ${appended.error ?? "unknown error"}`,
        );
      }
      state.backedManagedOutgoingContent = true;
      continuationMessage = appended.message;
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
  const message =
    continuationMessage && agentRunReplyPayloads.length === 1
      ? continuationMessage
      : {
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
    params.publishMessage(message, deliveryAuthorized);
  }
  return { kind: "delivered", hasSourceReplyTranscriptMirror };
}

/** Own direct source publication and its delivery outcome independently of the model terminal. */
export function createChatSendSourceReplyDelivery(params: FinalizeChatSendAgentRepliesBase) {
  let failure: { error: unknown } | undefined;
  const fail = (error: unknown): never => {
    failure = { error };
    throw error;
  };
  const finalize = async (batch: {
    deliveredReplies: readonly DeliveredChatSendReply[];
    hasReturnedAgentErrorPayloads: boolean;
    suppressFinal?: boolean;
  }): Promise<ChatSendAgentReplyFinalization> => {
    try {
      return await finalizeChatSendAgentReplyPayloads({
        ...params,
        suppressFinal: batch.suppressFinal,
        inputs: selectChatSendAgentReplyInputs(batch),
      });
    } catch (error) {
      // Both inline acknowledgments and post-dispatch source replies settle host
      // delivery independently of an already-recorded model terminal.
      return fail(error);
    }
  };
  return {
    finalize,
    hasDeliveryFailure: () => failure !== undefined,
    assertDeliverySucceeded: () => {
      if (failure) {
        throw failure.error;
      }
    },
    deliverContinuation: async (reply: DeliveredChatSendReply) => {
      const result = await finalize({
        deliveredReplies: [reply],
        hasReturnedAgentErrorPayloads: false,
      });
      if (result.kind !== "delivered") {
        fail(new Error("Waiting reply was not published."));
      }
    },
  };
}
