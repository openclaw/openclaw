import { expectDefined } from "@openclaw/normalization-core";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { getReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { ReplyDispatchOperation } from "../../auto-reply/reply/reply-dispatcher.types.js";
import { applyAssistantDeliveryDirectives } from "../../config/sessions/transcript-assistant-delivery.js";
import { readAssistantDisplayContent } from "../../shared/assistant-display-content.js";
import { appendChatCanvasBlocksToMessage } from "../chat-display-projection.canvas.js";
import { attachManagedOutgoingMediaToMessage } from "../managed-image-attachments.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "../session-utils-store-worker.js";
import {
  combineNonStreamingReplyParts,
  extractAssistantDisplayText,
  hasAssistantDisplayMediaContent,
  hasManagedOutgoingAssistantContent,
  hasVisibleAssistantFinalMessage,
  isMediaBearingPayload,
  stripManagedOutgoingAssistantContentBlocks,
} from "./chat-assistant-content.js";
import {
  broadcastChatFinal,
  broadcastChatTerminal,
  broadcastSideResult,
  isBtwReplyPayload,
} from "./chat-broadcast.js";
import { prepareWebchatReplyMediaForDisplay } from "./chat-reply-media.js";
import {
  buildTranscriptReplyTextFromInputs,
  readChatSendReplyPayload,
  selectChatSendFinalReplyInputs,
  type DeliveredChatSendReply,
} from "./chat-send-command-replies.js";
import {
  createChatSendReplyFinalizationAuthority,
  type ChatSendReplyFinalizationParams,
} from "./chat-send-delivery-authority.js";
import {
  appendInjectedAssistantMessageToTranscript,
  type GatewayInjectedTtsSupplementMarker,
} from "./chat-transcript-inject.js";
import {
  buildMediaOnlyTtsSupplementTranscriptMarker,
  buildTtsSupplementTranscriptMarker,
} from "./chat-tts-markers.js";
import type { GatewayChatUserTurnPersist } from "./chat-user-turn-recorder.js";

export const retainCommittedChatReplyMedia: NonNullable<
  Parameters<typeof appendInjectedAssistantMessageToTranscript>[0]["onMessageCommitted"]
> = (receipt, acceptCompletion) => {
  const blocks = readAssistantDisplayContent(receipt.message);
  if (hasManagedOutgoingAssistantContent(blocks)) {
    acceptCompletion(async () => {
      await attachManagedOutgoingMediaToMessage({ messageId: receipt.messageId, blocks });
    });
  }
};

type TranscriptMirrorOwner = {
  agentId?: string;
  expectedSessionId?: string;
  sessionKey: string;
};

type TranscriptMirrorResolution =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "blocked"; owner: TranscriptMirrorOwner }
  | { kind: "owner"; owner: TranscriptMirrorOwner };

function resolveTranscriptMirrorOwner(
  payloads: readonly ReplyPayload[],
): TranscriptMirrorResolution {
  const owners = payloads.map(
    (payload) => getReplyPayloadMetadata(payload)?.sourceReplyTranscriptMirror,
  );
  // Older source-reply mirrors have neither field and keep their existing source-session
  // behavior. Either field opts the batch into binding-owned transcript handling.
  if (
    owners.every(
      (owner) => owner?.expectedSessionId === undefined && !owner?.transcriptWriteBlocked,
    )
  ) {
    return { kind: "none" };
  }
  const first = owners[0];
  if (!first) {
    return { kind: "invalid" };
  }
  const sessionKey = first.sessionKey.trim();
  const expectedSessionId = first.expectedSessionId?.trim();
  if (
    !sessionKey ||
    (!first.transcriptWriteBlocked && !expectedSessionId) ||
    owners.some(
      (owner) =>
        (first.transcriptWriteBlocked && !owner?.transcriptWriteBlocked) ||
        owner?.sessionKey.trim() !== sessionKey ||
        owner.expectedSessionId?.trim() !== expectedSessionId ||
        owner.agentId !== first.agentId ||
        (!first.transcriptWriteBlocked && owner.transcriptWriteBlocked === true),
    )
  ) {
    return { kind: "invalid" };
  }
  return {
    kind: first.transcriptWriteBlocked ? "blocked" : "owner",
    owner: {
      sessionKey,
      ...(expectedSessionId ? { expectedSessionId } : {}),
      ...(first.agentId ? { agentId: first.agentId } : {}),
    },
  };
}

function buildChatSendBtwSideResult(deliveredReplies: readonly DeliveredChatSendReply[]) {
  const replies = deliveredReplies
    .map((entry) => readChatSendReplyPayload(entry.input))
    .filter(isBtwReplyPayload);
  const text = combineNonStreamingReplyParts(replies.map((payload) => payload.text));
  if (replies.length === 0 || !text) {
    return undefined;
  }
  return {
    question: expectDefined(replies[0], "btw replies entry at 0").btw.question.trim(),
    text,
    isError: replies.some((payload) => payload.isError),
  };
}

/** Finalize settled reply payloads, retaining the runtime's transcript ownership and outcome. */
export async function finalizeChatSendDispatchedReplies(
  params: ChatSendReplyFinalizationParams & {
    deliveredReplies: readonly DeliveredChatSendReply[];
    foldCommandBlocks: boolean;
    persistUserTurnTranscript: GatewayChatUserTurnPersist;
    suppressReplies: boolean;
    runtimeOwnsTranscript?: boolean;
    state: "final" | "aborted";
    stopReason?: string;
  },
): Promise<void> {
  const {
    context,
    deliveredReplies,
    emitFirstAssistantServerTiming,
    foldCommandBlocks,
    persistUserTurnTranscript,
    session,
    suppressReplies,
  } = params;
  const { agentId, backingSessionId, cfg, clientRunId, sessionKey, sessionLoadOptions } = session;
  const stopReason = params.state === "aborted" ? "aborted" : "stop";
  const btwResult = buildChatSendBtwSideResult(deliveredReplies);
  if (btwResult) {
    broadcastSideResult({
      context,
      payload: {
        kind: "btw",
        runId: clientRunId,
        sessionKey,
        ...(agentId ? { agentId } : {}),
        ...btwResult,
        ts: Date.now(),
      },
    });
    broadcastChatFinal({
      terminalEntry: params.terminalEntry,
      context,
      runId: clientRunId,
      sessionKey,
      agentId,
    });
    return;
  }

  const contextFreeCommand =
    !params.runtimeOwnsTranscript &&
    deliveredReplies.length > 0 &&
    deliveredReplies.every(({ input }) => {
      const payload = readChatSendReplyPayload(input);
      const metadata = getReplyPayloadMetadata(payload);
      return (
        metadata?.commandReply === true &&
        metadata.contextFreeCommand === true &&
        metadata.assistantTranscriptOwned !== true
      );
    });
  const selectedInputs = selectChatSendFinalReplyInputs({
    deliveredReplies,
    foldCommandBlocks,
    suppressReplies,
  });
  const rawFinalPayloads = selectedInputs.map(readChatSendReplyPayload);
  const { authorizeDelivery, captureMediaScope, release } =
    await createChatSendReplyFinalizationAuthority(params, rawFinalPayloads, () =>
      broadcastChatFinal({
        context,
        runId: clientRunId,
        sessionKey,
        agentId,
        terminalEntry: params.terminalEntry,
      }),
    );
  try {
    const transcriptMirrorResolution = resolveTranscriptMirrorOwner(rawFinalPayloads);
    const transcriptMirrorOwner =
      transcriptMirrorResolution.kind === "owner" || transcriptMirrorResolution.kind === "blocked"
        ? transcriptMirrorResolution.owner
        : undefined;
    const mediaScope = await captureMediaScope();
    if (!mediaScope) {
      return;
    }
    const sourceSession = await loadGatewaySessionEntryReadOnlyInWorker({
      cfg: context.getRuntimeConfig(),
      key: sessionKey,
      ...sessionLoadOptions,
      projection: [],
    });
    const requestedTranscriptSession = transcriptMirrorOwner
      ? await loadGatewaySessionEntryReadOnlyInWorker({
          cfg: context.getRuntimeConfig(),
          key: transcriptMirrorOwner.sessionKey,
          ...sessionLoadOptions,
          ...(transcriptMirrorOwner.agentId ? { agentId: transcriptMirrorOwner.agentId } : {}),
          projection: [],
        })
      : undefined;
    // Binding-owned payloads already retargeted the user turn. Keep the assistant
    // beside it only when that durable target still exists. Never fall back to the
    // source transcript after ownership metadata appears on any final payload.
    const useTranscriptMirrorOwner = Boolean(
      transcriptMirrorResolution.kind === "owner" &&
      transcriptMirrorOwner &&
      requestedTranscriptSession?.entry?.sessionId === transcriptMirrorOwner.expectedSessionId,
    );
    if (transcriptMirrorResolution.kind === "owner" && !useTranscriptMirrorOwner) {
      context.logGateway.warn(
        `webchat transcript append skipped: binding-owned session changed before finalization`,
      );
    }
    if (transcriptMirrorResolution.kind === "invalid") {
      context.logGateway.warn(
        `webchat transcript append skipped: inconsistent binding-owned transcript metadata`,
      );
    }
    if (transcriptMirrorResolution.kind === "blocked") {
      context.logGateway.warn(
        `webchat transcript append skipped: binding-owned user turn was not persisted`,
      );
    }
    const canAppendAssistantTranscript =
      transcriptMirrorResolution.kind === "none" || useTranscriptMirrorOwner;
    const transcriptSessionKey =
      useTranscriptMirrorOwner && transcriptMirrorOwner
        ? transcriptMirrorOwner.sessionKey
        : sessionKey;
    const transcriptAgentId =
      useTranscriptMirrorOwner && transcriptMirrorOwner
        ? (transcriptMirrorOwner.agentId ?? agentId)
        : agentId;
    const resolvedTranscriptSession =
      useTranscriptMirrorOwner && requestedTranscriptSession
        ? requestedTranscriptSession
        : sourceSession;
    const { storePath: latestStorePath, entry: latestEntry } = resolvedTranscriptSession;
    const sessionId = latestEntry?.sessionId ?? backingSessionId ?? clientRunId;
    const {
      payloads: finalPayloads,
      inputs: finalInputs,
      mediaMessage,
      assistantContent,
      persistedAssistantContent,
      broadcastContent: broadcastAssistantContent,
      managedMediaPrepareFailed,
    } = await prepareWebchatReplyMediaForDisplay({
      scope: mediaScope,
      storePath: sourceSession.storePath,
      transcriptTarget: { sessionKey: transcriptSessionKey, agentId: transcriptAgentId },
      inputs: selectedInputs,
      abortSignal: params.abortSignal,
      includeSensitiveMedia: false,
      includeSensitiveDisplay: true,
      logGateway: context.logGateway,
    });
    const ttsSupplementMarker = finalPayloads
      .map((payload) => buildMediaOnlyTtsSupplementTranscriptMarker(payload))
      .find((marker): marker is GatewayInjectedTtsSupplementMarker => Boolean(marker));
    const persistedContentForAppend = hasAssistantDisplayMediaContent(persistedAssistantContent)
      ? persistedAssistantContent
      : undefined;
    const displayReply =
      extractAssistantDisplayText(assistantContent) ??
      buildTranscriptReplyTextFromInputs(finalInputs);
    const transcriptDisplayReply = displayReply?.trim() ?? "";
    const transcriptReply =
      mediaMessage?.transcriptText ||
      (managedMediaPrepareFailed
        ? transcriptDisplayReply
        : buildTranscriptReplyTextFromInputs(finalInputs)) ||
      transcriptDisplayReply;
    let message: Record<string, unknown> | undefined;
    const payloadOwnsAssistantTranscript = rawFinalPayloads.some(
      (payload) => getReplyPayloadMetadata(payload)?.assistantTranscriptOwned === true,
    );
    const shouldAppendAssistantTranscript = Boolean(
      ((!params.runtimeOwnsTranscript && !payloadOwnsAssistantTranscript) ||
        useTranscriptMirrorOwner) &&
      canAppendAssistantTranscript &&
      (transcriptReply || persistedContentForAppend?.length),
    );
    if (contextFreeCommand) {
      await persistUserTurnTranscript({ contextFreeCommand: true });
    } else {
      await persistUserTurnTranscript();
    }
    if (!authorizeDelivery("transcript append")) {
      return;
    }
    if (shouldAppendAssistantTranscript) {
      const appended = await appendInjectedAssistantMessageToTranscript({
        sessionKey: transcriptSessionKey,
        message: transcriptReply,
        ...(persistedContentForAppend?.length ? { content: persistedContentForAppend } : {}),
        sessionId,
        storePath: latestStorePath,
        agentId: transcriptAgentId,
        idempotencyKey: clientRunId,
        stopReason,
        ttsSupplement: ttsSupplementMarker,
        ...(contextFreeCommand ? { contextFreeCommand: true } : {}),
        config: cfg,
        onMessageCommitted: retainCommittedChatReplyMedia,
      });
      if (appended.ok) {
        message = broadcastAssistantContent?.length
          ? applyAssistantDeliveryDirectives({
              ...appended.message,
              content: broadcastAssistantContent.map((block) => ({ ...block })),
            })
          : appended.message;
      } else {
        context.logGateway.warn(
          `webchat transcript append failed: ${appended.error ?? "unknown error"}`,
        );
        const fallbackAssistantContent =
          stripManagedOutgoingAssistantContentBlocks(persistedAssistantContent) ??
          stripManagedOutgoingAssistantContentBlocks(assistantContent);
        const fallbackText = extractAssistantDisplayText(fallbackAssistantContent) ?? displayReply;
        message = {
          role: "assistant",
          ...(fallbackAssistantContent?.length
            ? { content: fallbackAssistantContent }
            : fallbackText
              ? { content: [{ type: "text", text: fallbackText }] }
              : {}),
          ...(fallbackText ? { text: fallbackText } : {}),
          timestamp: Date.now(),
          ...(ttsSupplementMarker ? { openclawTtsSupplement: ttsSupplementMarker } : {}),
          stopReason,
          usage: { input: 0, output: 0, totalTokens: 0 },
        };
      }
    } else if (broadcastAssistantContent?.length) {
      message = {
        role: "assistant",
        content: broadcastAssistantContent,
        text: extractAssistantDisplayText(broadcastAssistantContent) ?? "",
        timestamp: Date.now(),
        stopReason,
        usage: { input: 0, output: 0, totalTokens: 0 },
      };
    }
    if (!authorizeDelivery("broadcast")) {
      return;
    }
    const run = context.chatRunState.runs.get(clientRunId);
    if (!suppressReplies && run?.bufferIsCurrent?.() !== false) {
      // Only an authorized delivered message receives previews; an absent message
      // can be a deliberate post-hook suppression, not a tool-only reply.
      message = appendChatCanvasBlocksToMessage(message, run?.canvasBlocks ?? []);
    }
    if (hasVisibleAssistantFinalMessage(message)) {
      emitFirstAssistantServerTiming();
    }
    broadcastChatTerminal({
      terminalEntry: params.terminalEntry,
      context,
      runId: clientRunId,
      sessionKey,
      agentId,
      message,
      state: params.state,
      stopReason: params.stopReason,
    });
  } finally {
    release();
  }
}

export const agentMediaTranscriptKey = (payload: ReplyPayload): string | undefined => {
  if (
    !isMediaBearingPayload(payload) &&
    !getReplyPayloadMetadata(payload)?.assistantMediaFailures?.length
  ) {
    return undefined;
  }
  const metadata = getReplyPayloadMetadata(payload);
  const supplement = buildTtsSupplementTranscriptMarker(payload);
  const prefix = supplement ? `tts:${supplement.textSha256}:` : "";
  const ownedIdempotencyKey =
    metadata?.assistantTranscriptOwned === true
      ? metadata.assistantTranscriptIdempotencyKey?.trim()
      : undefined;
  if (ownedIdempotencyKey) {
    return `${prefix}owned:${ownedIdempotencyKey}`;
  }
  const contentIndex = metadata?.assistantMessageIndex;
  const source = metadata?.assistantTranscriptSource;
  const sourceId = source?.itemId ?? source?.committedMessageId;
  if (sourceId) {
    const sourceKey = `${prefix}source:${sourceId}`;
    return contentIndex === undefined ? sourceKey : `${sourceKey}:index:${contentIndex}`;
  }
  return `${prefix}${contentIndex === undefined ? "unkeyed" : `index:${contentIndex}`}`;
};

/** Select delivered coverage before preparing each committed response as one media batch. */
export function selectAgentMediaTranscriptInputs(
  deliveredReplies: readonly DeliveredChatSendReply[],
): ReplyDispatchOperation[][] {
  const latestPayloadByKey = new Map<string, ReplyDispatchOperation>();
  const byOccurrence = new Map<string, Map<string, ReplyDispatchOperation>>();
  for (const { input } of deliveredReplies) {
    const payload = readChatSendReplyPayload(input);
    const key = agentMediaTranscriptKey(payload);
    if (!key) {
      continue;
    }
    latestPayloadByKey.set(key, input);
    const source = getReplyPayloadMetadata(payload)?.assistantTranscriptSource;
    const sourceId = source?.itemId ?? source?.committedMessageId;
    if (sourceId && key.startsWith("source:")) {
      const group = byOccurrence.get(sourceId) ?? new Map<string, ReplyDispatchOperation>();
      // Keep actual delivery order when an aggregate reuses an earlier index.
      group.delete(key);
      group.set(key, input);
      byOccurrence.set(sourceId, group);
    }
  }
  const payloadMediaUrls = (payload: ReplyPayload) =>
    resolveSendableOutboundReplyParts(payload).mediaUrls;
  const failureKeys = (payload: ReplyPayload) =>
    (getReplyPayloadMetadata(payload)?.assistantMediaFailures ?? []).map((failure) =>
      JSON.stringify([failure.code, failure.kind, failure.label, failure.mimeType ?? null]),
    );
  for (const group of byOccurrence.values()) {
    const inputs = Array.from(group.values());
    const latest = inputs.at(-1);
    if (!latest || inputs.length < 2) {
      continue;
    }
    const latestPayload = readChatSendReplyPayload(latest);
    if (getReplyPayloadMetadata(latestPayload)?.assistantTranscriptAggregate !== true) {
      continue;
    }
    const coveredUrls = new Set(payloadMediaUrls(latestPayload));
    const coveredFailures = failureKeys(latestPayload);
    const preceding = inputs.slice(0, -1);
    const requiredFailures = preceding.flatMap((input) =>
      failureKeys(readChatSendReplyPayload(input)),
    );
    const coversFailures = requiredFailures.every((failure) => {
      const index = coveredFailures.indexOf(failure);
      if (index < 0) {
        return false;
      }
      coveredFailures.splice(index, 1);
      return true;
    });
    // A committed receipt does not prove message_end's aggregate was delivered.
    // Coalesce only producer-owned aggregates with actual coverage; partial/error
    // unwind keeps each content index, including identical URLs or failure cards.
    if (
      !coversFailures ||
      !preceding.every((input) =>
        payloadMediaUrls(readChatSendReplyPayload(input)).every((url) => coveredUrls.has(url)),
      )
    ) {
      continue;
    }
    for (const [key, input] of group) {
      if (input !== latest) {
        latestPayloadByKey.delete(key);
      }
    }
  }
  const batches = new Map<string, ReplyDispatchOperation[]>();
  for (const [key, input] of latestPayloadByKey) {
    const payload = readChatSendReplyPayload(input);
    const messageId =
      getReplyPayloadMetadata(payload)?.assistantTranscriptSource?.committedMessageId;
    const batchKey =
      key.startsWith("source:") && messageId && !buildTtsSupplementTranscriptMarker(payload)
        ? `message:${messageId}`
        : key;
    const batch = batches.get(batchKey) ?? [];
    batch.push(input);
    batches.set(batchKey, batch);
  }
  return Array.from(batches.values());
}
