import { createHash } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { getReplyPayloadMetadata, type ReplyPayload } from "../auto-reply/reply-payload.js";
import { parseReplyDirectives } from "../auto-reply/reply/reply-directives.js";
import { resolveSessionWorkStartError } from "../config/sessions/lifecycle.js";
import {
  loadSessionEntryReadOnly,
  persistSessionTranscriptTurn,
  publishTranscriptUpdate,
  readActiveTranscriptEntryAnchor,
} from "../config/sessions/session-accessor.js";
import {
  findTranscriptEvent,
  readTranscriptEventId,
  readTranscriptEventMessage,
} from "../config/sessions/session-accessor.sqlite-read.js";
import { readCommittedTranscriptMessageSequence } from "../config/sessions/session-accessor.sqlite-transcript-sequences.js";
import { captureOwnedTranscriptWriteAssertion } from "../config/sessions/transcript-write-context.js";
import type { SessionTranscriptAssistantMessage } from "../config/sessions/transcript.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeMediaReferenceForComparison } from "../media/media-reference-comparison.js";
import { readSessionTranscriptRunId } from "../sessions/transcript-events.js";
import { resolveRawAssistantAnswerText } from "../shared/assistant-answer-text.js";
import { readAssistantDisplayContent } from "../shared/assistant-display-content.js";
import {
  isOpenClawDeliveryMirrorAssistantMessage,
  OPENCLAW_TRANSCRIPT_ARTIFACT_API,
  OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
} from "../shared/transcript-only-openclaw-assistant.js";
import { formatErrorMessage } from "./errors.js";
import { heartbeatLog as log } from "./heartbeat-log.js";

type HeartbeatSessionPublication = { ok: true; messageId: string } | { ok: false; reason: string };

/** Publishes an admitted heartbeat final before its completion occurrences can settle. */
export async function publishHeartbeatSessionReply(params: {
  cfg: OpenClawConfig;
  agentId: string;
  storePath: string;
  sessionKey: string;
  expectedGeneration: { sessionId: string; lifecycleRevision: string | undefined };
  occurrenceIds: readonly string[];
  payload: ReplyPayload;
  sourceText?: string;
  signal?: AbortSignal;
}): Promise<HeartbeatSessionPublication> {
  let acceptedPublication: Promise<HeartbeatSessionPublication> | undefined;
  try {
    const { text, mediaUrls } = resolveSendableOutboundReplyParts(params.payload);
    const occurrences = [...new Set(params.occurrenceIds)].toSorted();
    if (occurrences.length === 0 || occurrences.some((id) => !id.trim())) {
      return { ok: false, reason: "heartbeat session publication has no completion identity" };
    }
    const scope = {
      agentId: params.agentId,
      storePath: params.storePath,
      sessionKey: params.sessionKey,
      sessionId: params.expectedGeneration.sessionId,
    };
    const assertOwnedWrite = captureOwnedTranscriptWriteAssertion(scope);
    const metadata = getReplyPayloadMetadata(params.payload);
    const authority = metadata?.sessionWriterDeliveryAuthority;
    const initial = loadSessionEntryReadOnly({ ...scope, readConsistency: "latest" });
    const writerRunId = authority?.expectedWriterRunId ?? initial?.activeWriterRunId;
    const expected = {
      expectedSessionId: scope.sessionId,
      expectedLifecycleRevision: params.expectedGeneration.lifecycleRevision ?? null,
      ...(writerRunId ? { expectedWriterRunId: writerRunId } : {}),
    };
    // Delivery is already admitted. Preserve its fence through the queued write;
    // waiting for all session admissions here would wait for this very delivery.
    const assertCurrent = (messageId?: string) => {
      params.signal?.throwIfAborted();
      assertOwnedWrite();
      const current = loadSessionEntryReadOnly({ ...scope, readConsistency: "latest" });
      if (
        !scope.sessionId ||
        current?.sessionId !== scope.sessionId ||
        current.lifecycleRevision !== params.expectedGeneration.lifecycleRevision ||
        current.activeWriterRunId !== writerRunId ||
        (authority &&
          (authority.sessionKey !== scope.sessionKey ||
            (authority.agentId !== undefined && authority.agentId !== scope.agentId) ||
            authority.expectedSessionId !== scope.sessionId ||
            (authority.expectedLifecycleRevision !== undefined &&
              authority.expectedLifecycleRevision !== current.lifecycleRevision))) ||
        (messageId && !readActiveTranscriptEntryAnchor({ ...scope, entryId: messageId }))
      ) {
        throw new Error("heartbeat publication no longer owns the active transcript");
      }
      const unavailable = resolveSessionWorkStartError(scope.sessionKey, current, expected);
      if (unavailable) {
        throw new Error(unavailable);
      }
    };
    assertCurrent();
    const mirror = metadata?.sourceReplyTranscriptMirror?.transcriptOwner
      ? metadata.sourceReplyTranscriptMirror
      : undefined;
    if (
      mirror &&
      (!mirror.idempotencyKey ||
        mirror.sessionKey !== scope.sessionKey ||
        (mirror.expectedSessionId && mirror.expectedSessionId !== scope.sessionId) ||
        (mirror.agentId && mirror.agentId !== scope.agentId))
    ) {
      return { ok: false, reason: "heartbeat source receipt belongs to another target" };
    }
    const owned =
      metadata?.assistantTranscriptOwned === true ||
      metadata?.assistantMessageIndex !== undefined ||
      mirror !== undefined;
    if (!owned && (!text.trim() || mediaUrls.length > 0)) {
      return { ok: false, reason: "heartbeat session publication requires a text-only reply" };
    }
    const key = `heartbeat-completion:${createHash("sha256")
      .update(JSON.stringify([scope.sessionId, expected.expectedLifecycleRevision, occurrences]))
      .digest("hex")}`;
    const ownedKey = mirror?.idempotencyKey ?? metadata?.assistantTranscriptIdempotencyKey;
    const lookupKey = owned ? ownedKey : key;
    let prior = lookupKey
      ? await findTranscriptEvent(scope, (event) => {
          const message = readTranscriptEventMessage(event);
          return (
            message?.role === "assistant" &&
            message.idempotencyKey === lookupKey &&
            (!owned ||
              (mirror
                ? isOpenClawDeliveryMirrorAssistantMessage(message)
                : Boolean(writerRunId && readSessionTranscriptRunId(message) === writerRunId)))
          );
        })
      : undefined;
    if (owned && !ownedKey && writerRunId) {
      // Stream indices advance between content blocks, not persisted messages.
      // The current writer's newest active assistant supplies the receipt identity.
      prior = await findTranscriptEvent(scope, (event) => {
        const message = readTranscriptEventMessage(event);
        const messageId = readTranscriptEventId(event);
        return (
          message?.role === "assistant" &&
          readSessionTranscriptRunId(message) === writerRunId &&
          Boolean(messageId && readActiveTranscriptEntryAnchor({ ...scope, entryId: messageId }))
        );
      });
    }
    const priorMessage = prior && readTranscriptEventMessage(prior.event);
    const priorId = prior && readTranscriptEventId(prior.event);
    const answer = parseReplyDirectives(resolveRawAssistantAnswerText(priorMessage));
    const originalMedia = mirror?.mediaUrls ?? metadata?.assistantTranscriptMediaUrls ?? mediaUrls;
    const storedMedia = asOptionalRecord(priorMessage?.openclawDelivery)?.mediaUrls;
    const displayMedia = readAssistantDisplayContent(priorMessage).filter((block) =>
      ["image", "audio", "video", "attachment"].includes(String(block.type)),
    );
    // Managed mirrors retain source identities separately from their display URLs.
    const receiptMedia =
      displayMedia.length > 0 &&
      Array.isArray(storedMedia) &&
      storedMedia.every((source): source is string => typeof source === "string")
        ? storedMedia
        : (answer.mediaUrls ?? []);
    // Runtime payloads carry original references even after delivery URLs change.
    // Extra tool media is not covered by an ordinary assistant's receipt.
    const matchesMedia =
      (displayMedia.length === 0 || displayMedia.length === originalMedia.length) &&
      receiptMedia.length === originalMedia.length &&
      originalMedia.length === mediaUrls.length &&
      receiptMedia.every(
        (source, index) =>
          normalizeMediaReferenceForComparison(source) ===
          normalizeMediaReferenceForComparison(originalMedia[index]!),
      );
    if (
      (prior && (!priorMessage || !priorId)) ||
      (owned &&
        (!priorId ||
          !priorMessage ||
          (!text.trim() && mediaUrls.length === 0) ||
          answer.text.trim() !==
            (mirror ? (mirror.text ?? "") : (params.sourceText ?? text)).trim() ||
          !matchesMedia))
    ) {
      return { ok: false, reason: "heartbeat runtime final has no matching committed receipt" };
    }
    assertCurrent(priorId);
    const content: SessionTranscriptAssistantMessage["content"] = [
      { type: "text", text: text.trim() },
    ];
    const message =
      owned && priorMessage
        ? priorMessage
        : {
            ...(priorMessage ??
              ({
                role: "assistant",
                content,
                api: OPENCLAW_TRANSCRIPT_ARTIFACT_API,
                provider: OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
                // Unlike delivery mirrors, completion notifications remain model context.
                model: "automation-result",
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "stop",
                timestamp: Date.now(),
                idempotencyKey: key,
              } satisfies SessionTranscriptAssistantMessage & { idempotencyKey: string })),
            content,
          };
    const attachMedia =
      displayMedia.length > 0
        ? (await import("../gateway/managed-image-attachments.js"))
            .attachManagedOutgoingMediaToMessage
        : undefined;
    assertCurrent(priorId);
    // Exact replay preserves runtime rows and rejects changed notification bytes.
    // The transaction guard also prevents resurrecting a removed/abandoned row.
    const committed = await persistSessionTranscriptTurn(scope, {
      ...expected,
      config: params.cfg,
      messages: [
        {
          message,
          ...(priorId ? { eventId: priorId } : {}),
          idempotencyLookup: "scan",
          shouldAppendInTransaction: () => {
            assertCurrent(priorId);
            return true;
          },
        },
      ],
      touchSessionEntry: !owned,
      // Accept at the committed-message boundary, while the writer still owns it.
      // A later drain failure cannot revoke a notification already published here.
      updateMode: "none",
      onMessageCommitted: (receipt) => {
        assertCurrent(receipt.messageId);
        if (attachMedia && !attachMedia({ messageId: receipt.messageId, blocks: displayMedia })) {
          throw new Error("heartbeat source receipt media custody is unavailable");
        }
        const messageSeq = readCommittedTranscriptMessageSequence(receipt);
        assertCurrent(receipt.messageId);
        // The canonical emitter runs synchronously. Replays invalidate history,
        // without emitting the same assistant message inline again.
        acceptedPublication = publishTranscriptUpdate(
          scope,
          receipt.appended
            ? {
                lifecycleRevision: expected.expectedLifecycleRevision ?? undefined,
                message: receipt.message,
                messageId: receipt.messageId,
                ...(messageSeq !== undefined ? { messageSeq } : {}),
              }
            : {},
        ).then(
          () => ({ ok: true, messageId: receipt.messageId }),
          (error: unknown) => ({ ok: false, reason: formatErrorMessage(error) }),
        );
      },
    });
    return (
      acceptedPublication ?? {
        ok: false,
        reason: committed.rejectedReason ?? "heartbeat publication rejected",
      }
    );
  } catch (error) {
    if (acceptedPublication) {
      const receipt = await acceptedPublication;
      if (receipt.ok) {
        log.warn("heartbeat: publication accepted before owned-write cleanup failed", {
          error: formatErrorMessage(error),
        });
      }
      return receipt;
    }
    return { ok: false, reason: formatErrorMessage(error) };
  }
}
