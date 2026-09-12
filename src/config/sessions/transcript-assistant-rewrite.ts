import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeMediaReferenceForComparison } from "../../media/media-reference-comparison.js";
import { splitMediaFromOutput } from "../../media/parse.js";
import {
  loadTranscriptEventRowsAfterSeqSync,
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  publishTranscriptUpdate,
  readSessionTranscriptWatermark,
  rewriteTranscriptEventRowsExact,
  type SessionTranscriptWriteScope,
  type TranscriptEvent,
} from "./session-accessor.js";
import type { SessionEntry } from "./types.js";

export type AssistantTranscriptRewriteStart = {
  sessionId: string;
  generation: string | null;
  afterSeq: number;
};

export function captureAssistantTranscriptRewriteStart(
  scope: SessionTranscriptWriteScope & { sessionId: string },
): AssistantTranscriptRewriteStart {
  const watermark = readSessionTranscriptWatermark(scope);
  return {
    sessionId: scope.sessionId,
    generation: watermark.generation,
    afterSeq: watermark.maxSeq ?? 0,
  };
}

function eventId(event: TranscriptEvent): string | undefined {
  const id = asOptionalRecord(event)?.id;
  return typeof id === "string" && id.trim() ? id : undefined;
}

function eventMessage(event: TranscriptEvent): Record<string, unknown> | undefined {
  return asOptionalRecord(asOptionalRecord(event)?.message);
}

export function findAssistantTranscriptMessageByIdempotencyKeyInEvents(
  events: readonly TranscriptEvent[],
  idempotencyKey: string,
): { messageId: string; message: Record<string, unknown> } | null {
  const trimmedIdempotencyKey = idempotencyKey.trim();
  if (!trimmedIdempotencyKey) {
    return null;
  }
  const target = events.toReversed().find((event) => {
    const message = eventMessage(event);
    return message?.role === "assistant" && message.idempotencyKey === trimmedIdempotencyKey;
  });
  const message = target ? eventMessage(target) : undefined;
  const messageId = target ? eventId(target) : undefined;
  if (!messageId || !message) {
    return null;
  }
  return { messageId, message };
}

export function extractAssistantTranscriptText(
  message: Record<string, unknown>,
): string | undefined {
  const content = message.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .map((block) => {
      const value = asOptionalRecord(block);
      return value?.type === "text" && typeof value.text === "string" ? value.text.trim() : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
  return text || undefined;
}

function findAssistantTranscriptMessageByTurnIndexAndMediaInEvents(
  events: readonly TranscriptEvent[],
  params: { assistantMessageIndex: number; mediaUrls: readonly string[] },
): { messageId: string; message: Record<string, unknown> } | null {
  const expectedMedia = new Set(
    params.mediaUrls
      .map((value) => normalizeMediaReferenceForComparison(value))
      .filter((value) => value.length > 0),
  );
  if (!Number.isSafeInteger(params.assistantMessageIndex) || params.assistantMessageIndex < 1) {
    return null;
  }
  const target = events.filter((event) => eventMessage(event)?.role === "assistant")[
    params.assistantMessageIndex - 1
  ];
  const message = target ? eventMessage(target) : undefined;
  const messageId = target ? eventId(target) : undefined;
  const text = message ? extractAssistantTranscriptText(message) : undefined;
  if (!messageId || !message || !text) {
    return null;
  }
  const actualMedia = new Set(
    (splitMediaFromOutput(text).mediaUrls ?? [])
      .map((value) => normalizeMediaReferenceForComparison(value))
      .filter((value) => value.length > 0),
  );
  const exactMediaMatch =
    actualMedia.size === expectedMedia.size &&
    [...expectedMedia].every((value) => actualMedia.has(value));
  return exactMediaMatch ? { messageId, message } : null;
}

/** Rewrites only a captured assistant identity inside its original transcript generation. */
export async function rewriteAssistantTranscriptMessageByTurnIdentity(params: {
  afterSeq: number;
  identity:
    | { kind: "entry"; id: string }
    | { kind: "idempotency"; key: string }
    | { kind: "stream"; index: number };
  expectedGeneration: string | null;
  mediaUrls: readonly string[];
  rewriteMessage: (message: Record<string, unknown>) => Record<string, unknown>;
  canCommit?: (current: SessionEntry | undefined) => boolean;
  scope: SessionTranscriptWriteScope & { sessionId: string };
}): Promise<{ generation: string; messageId: string } | null> {
  const currentWatermark = readSessionTranscriptWatermark(params.scope);
  const initialGenerationMaterialized = params.expectedGeneration === null && params.afterSeq === 0;
  if (currentWatermark.generation !== params.expectedGeneration && !initialGenerationMaterialized) {
    return null;
  }
  const rows = loadTranscriptEventRowsAfterSeqSync(params.scope, params.afterSeq);
  const messageId =
    params.identity.kind === "entry"
      ? params.identity.id
      : params.identity.kind === "idempotency"
        ? findAssistantTranscriptMessageByIdempotencyKeyInEvents(
            rows.map((row) => row.event),
            params.identity.key,
          )?.messageId
        : findAssistantTranscriptMessageByTurnIndexAndMediaInEvents(
            rows.map((row) => row.event),
            {
              assistantMessageIndex: params.identity.index,
              mediaUrls: params.mediaUrls,
            },
          )?.messageId;
  const target = rows.find((row) => eventId(row.event) === messageId);
  const message = target ? eventMessage(target.event) : undefined;
  if (!target || !messageId || message?.role !== "assistant") {
    return null;
  }
  const rewritten = await rewriteTranscriptEventRowsExact(params.scope, {
    allowInitialGenerationMaterialization: initialGenerationMaterialized,
    expectedGeneration: params.expectedGeneration,
    canCommit: params.canCommit,
    rows: [
      {
        event: Object.assign({}, target.event, { message: params.rewriteMessage(message) }),
        expectedEventJson: JSON.stringify(target.event),
        seq: target.seq,
      },
    ],
  });
  return rewritten ? { generation: rewritten.generation, messageId } : null;
}

export async function publishAssistantTranscriptRewrite(params: {
  scope: SessionTranscriptWriteScope;
  rewritten: readonly { messageId: string }[];
  canCommit?: (current: SessionEntry | undefined) => boolean;
}): Promise<boolean> {
  if (params.rewritten.length === 0) {
    return false;
  }
  if (params.canCommit && !params.scope.sessionKey) {
    return false;
  }
  if (params.scope.sessionKey && params.scope.sessionId) {
    const entryScope = {
      storePath: params.scope.storePath,
      sessionKey: params.scope.sessionKey,
      agentId: params.scope.agentId,
    };
    const updated = await patchSessionEntryCore(
      entryScope,
      (current) =>
        current.sessionId === params.scope.sessionId && (params.canCommit?.(current) ?? true)
          ? { updatedAt: Date.now() }
          : null,
      { skipMaintenance: true },
    );
    if (!updated) {
      return false;
    }
    if (
      params.canCommit &&
      !params.canCommit(loadSessionEntryReadOnly({ ...entryScope, readConsistency: "latest" }))
    ) {
      return false;
    }
  }
  await publishTranscriptUpdate(params.scope, { messageId: params.rewritten.at(-1)?.messageId });
  return true;
}
