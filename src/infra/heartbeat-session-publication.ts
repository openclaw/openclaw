import { createHash } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { makeZeroUsageSnapshot } from "../agents/usage.js";
import { getReplyPayloadMetadata, type ReplyPayload } from "../auto-reply/reply-payload.js";
import { parseReplyDirectives } from "../auto-reply/reply/reply-directives.js";
import { resolveSessionWorkStartError } from "../config/sessions/lifecycle.js";
import {
  loadExactSessionEntryReadOnly,
  loadSessionEntryReadOnly,
  persistSessionTranscriptTurn,
  publishTranscriptUpdate,
  readActiveTranscriptEntryAnchor,
} from "../config/sessions/session-accessor.js";
import {
  readTranscriptEventId,
  readTranscriptEventMessage,
} from "../config/sessions/session-accessor.sqlite-read.js";
import { readCommittedTranscriptMessageSequence } from "../config/sessions/session-accessor.sqlite-transcript-sequences.js";
import { findTranscriptEvent } from "../config/sessions/session-transcript-match.js";
import { resolveMirroredTranscriptText } from "../config/sessions/transcript-mirror.js";
import { captureOwnedTranscriptWriteAssertion } from "../config/sessions/transcript-write-context.js";
import type { SessionTranscriptAssistantMessage } from "../config/sessions/transcript.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeMediaReferenceForComparison } from "../media/media-reference-comparison.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { resolveRawAssistantAnswerText } from "../shared/assistant-answer-text.js";
import { readAssistantDisplayContent } from "../shared/assistant-display-content.js";
import {
  OPENCLAW_TRANSCRIPT_ARTIFACT_API,
  OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
} from "../shared/transcript-only-openclaw-assistant.js";
import { formatErrorMessage } from "./errors.js";
import { HEARTBEAT_DELIVERY_CONTEXT_KEY_PREFIX } from "./heartbeat-events-filter.js";
import { heartbeatLog as log } from "./heartbeat-log.js";
import {
  resolveOutboundPayloadMirrorText,
  type NormalizedOutboundPayload,
} from "./outbound/payloads.js";
import { withSystemEventOwner } from "./system-event-ownership.js";
import { enqueueSystemEvent } from "./system-events.js";

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
    const assertCurrent = () => {
      params.signal?.throwIfAborted();
      assertOwnedWrite();
      if (
        authority &&
        (authority.sessionKey !== scope.sessionKey ||
          (authority.agentId !== undefined && authority.agentId !== scope.agentId) ||
          authority.expectedSessionId !== scope.sessionId ||
          (authority.expectedLifecycleRevision !== undefined &&
            authority.expectedLifecycleRevision !== params.expectedGeneration.lifecycleRevision))
      ) {
        throw new Error("heartbeat publication no longer owns the active transcript");
      }
    };
    const assertTargetCurrent = (messageId?: string) => {
      assertCurrent();
      const current = loadSessionEntryReadOnly({ ...scope, readConsistency: "latest" });
      if (
        !scope.sessionId ||
        current?.sessionId !== scope.sessionId ||
        current.lifecycleRevision !== params.expectedGeneration.lifecycleRevision ||
        current.activeWriterRunId !== writerRunId ||
        (messageId && !readActiveTranscriptEntryAnchor({ ...scope, entryId: messageId }))
      ) {
        throw new Error("heartbeat publication no longer owns the active transcript");
      }
      const unavailable = resolveSessionWorkStartError(scope.sessionKey, current, {
        ...expected,
        purpose: "accepted-result-settlement",
      });
      if (unavailable) {
        throw new Error(unavailable);
      }
    };
    assertTargetCurrent();
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
    let prior =
      lookupKey && (!owned || mirror || writerRunId)
        ? await findTranscriptEvent(scope, {
            kind: "idempotency",
            key: lookupKey,
            assistant: true,
            ...(owned && mirror ? { deliveryMirror: true } : {}),
            ...(owned && !mirror ? { runId: writerRunId } : {}),
          })
        : undefined;
    if (owned && !ownedKey && writerRunId) {
      // Stream indices advance between content blocks, not persisted messages.
      prior = await findTranscriptEvent(scope, { kind: "active-assistant", runId: writerRunId });
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
    assertTargetCurrent(priorId);
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
                usage: makeZeroUsageSnapshot(),
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
    assertTargetCurrent(priorId);
    // Exact replay preserves runtime rows and rejects changed notification bytes.
    // The transaction guard also prevents resurrecting a removed/abandoned row.
    const committed = await persistSessionTranscriptTurn(scope, {
      ...expected,
      config: params.cfg,
      assertCurrent,
      acceptedResultGuard: {
        expectedWriterRunId: writerRunId ?? null,
        errorMessage: "heartbeat publication no longer owns the active transcript",
      },
      messages: [
        {
          message,
          ...(priorId
            ? {
                eventId: priorId,
                predicate: {
                  kind: "active-entry" as const,
                  entryId: priorId,
                  errorMessage: "heartbeat publication no longer owns the active transcript",
                },
              }
            : {}),
          idempotencyLookup: "scan",
        },
      ],
      touchSessionEntry: !owned,
      // Accept at the committed-message boundary, while the writer still owns it.
      // A later drain failure cannot revoke a notification already published here.
      updateMode: "none",
      onMessageCommitted: (receipt, acceptCompletion) => {
        assertTargetCurrent(receipt.messageId);
        const publish = (): Promise<HeartbeatSessionPublication> => {
          const messageSeq = readCommittedTranscriptMessageSequence(receipt);
          assertTargetCurrent(receipt.messageId);
          // Replays invalidate history without emitting the assistant message again.
          return publishTranscriptUpdate(
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
        };
        if (!attachMedia) {
          acceptedPublication = publish();
          return;
        }
        const completion = attachMedia({
          messageId: receipt.messageId,
          blocks: readAssistantDisplayContent(receipt.message),
        }).then((attached) => {
          if (!attached) {
            throw new Error("heartbeat source receipt media custody is unavailable");
          }
          return publish();
        });
        acceptedPublication = completion.catch((error: unknown) => ({
          ok: false,
          reason: formatErrorMessage(error),
        }));
        acceptCompletion(async () => {
          await completion;
        });
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

const MAX_HEARTBEAT_TARGET_AWARENESS_CHARS = 1_000;

export function prepareHeartbeatTargetAwareness(params: {
  agentId: string;
  storePath: string;
  runSessionKey: string;
  targetSessionKey?: string;
  startedAt: number;
}): ((payload: NormalizedOutboundPayload) => void) | undefined {
  const sessionKey = params.targetSessionKey?.trim();
  if (!sessionKey || sessionKey === params.runSessionKey) {
    return undefined;
  }
  try {
    if (resolveAgentIdFromSessionKey(sessionKey, params.agentId) !== params.agentId) {
      return undefined;
    }
    const scope = { agentId: params.agentId, storePath: params.storePath, sessionKey };
    const entry = loadExactSessionEntryReadOnly(scope)?.entry;
    if (!entry?.sessionId) {
      return undefined;
    }
    const expectedSessionId = entry.sessionId;
    const expectedLifecycleRevision = entry.lifecycleRevision;
    const idempotencyKey = `${HEARTBEAT_DELIVERY_CONTEXT_KEY_PREFIX}${params.startedAt}:${params.runSessionKey}`;
    return (payload) => {
      try {
        // Recheck the exact pre-send lifecycle before publishing awareness. Resets
        // can preserve sessionId while rotating lifecycleRevision.
        const latest = loadExactSessionEntryReadOnly(scope)?.entry;
        if (
          latest?.sessionId !== expectedSessionId ||
          latest.lifecycleRevision !== expectedLifecycleRevision
        ) {
          return;
        }
        const deliveredText = resolveMirroredTranscriptText({
          text: payload.hookContent ?? resolveOutboundPayloadMirrorText(payload),
          mediaUrls: payload.mediaUrls,
        });
        if (!deliveredText) {
          return;
        }
        const text = truncateUtf16Safe(deliveredText, MAX_HEARTBEAT_TARGET_AWARENESS_CHARS);
        const suffix = text.length < deliveredText.length ? "\n[truncated]" : "";
        enqueueSystemEvent(
          `A heartbeat delivered this message to this channel:\n${text}${suffix}`,
          withSystemEventOwner({ sessionKey, contextKey: idempotencyKey }, params.agentId),
        );
      } catch (error) {
        // Platform delivery already succeeded; projection remains best-effort bookkeeping.
        log.warn("heartbeat: failed to queue target session awareness", {
          error: formatErrorMessage(error),
        });
      }
    };
  } catch (error) {
    log.warn("heartbeat: failed to resolve existing target session projection", {
      error: formatErrorMessage(error),
    });
    return undefined;
  }
}
