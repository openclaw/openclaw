import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  loadSessionEntryReadOnly,
  readSessionTranscriptWatermark,
  type SessionTranscriptWriteScope,
} from "../../config/sessions/session-accessor.js";
import {
  publishAssistantTranscriptRewrite,
  rewriteAssistantTranscriptMessageByTurnIdentity,
  type AssistantTranscriptRewriteStart,
} from "../../config/sessions/transcript-assistant-rewrite.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { ASSISTANT_DISPLAY_CONTENT_FIELD } from "../../shared/assistant-display-content.js";
import { createDeferredCore, type Deferred } from "../../shared/deferred.js";
import {
  getReplyPayloadMetadata,
  isReplyPayloadSessionWriterDeliveryAuthorized,
  setReplyPayloadMetadata,
} from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";

type FinalReplyAcknowledgment = NonNullable<
  ReturnType<typeof getReplyPayloadMetadata>
>["onFinalDeliverySuccess"];
export type ModelNoticeTranscript = {
  scope: SessionTranscriptWriteScope & { sessionId: string; sessionKey: string };
  start: AssistantTranscriptRewriteStart;
  expectedSession: Pick<
    InternalSessionEntry,
    "sessionId" | "lifecycleRevision" | "activeWriterRunId" | "providerOverride" | "modelOverride"
  >;
  assertCurrent?: () => void;
};

type RewriteResult = { generation: string; messageId: string } | null;
type ModelNoticePublication = {
  payload: ReplyPayload;
  notice: string;
  transcript?: ModelNoticeTranscript;
  deferred: boolean;
  publication: Deferred;
  persisted?: RewriteResult;
  pending?: Promise<RewriteResult>;
  acknowledge: () => Promise<void>;
};
const publications = new WeakMap<NonNullable<FinalReplyAcknowledgment>, ModelNoticePublication>();
const log = createSubsystemLogger("model-notice");

function publicationFor(payload: ReplyPayload) {
  const callback = getReplyPayloadMetadata(payload)?.onFinalDeliverySuccess;
  return callback ? publications.get(callback) : undefined;
}

function isCurrent(
  owner: ModelNoticePublication,
  current: InternalSessionEntry | undefined,
): boolean {
  const target = owner.transcript;
  if (!target || !current) {
    return false;
  }
  target.assertCurrent?.();
  const expected = target.expectedSession;
  return (
    current.sessionId === expected.sessionId &&
    current.lifecycleRevision === expected.lifecycleRevision &&
    current.activeWriterRunId === expected.activeWriterRunId &&
    current.providerOverride === expected.providerOverride &&
    current.modelOverride === expected.modelOverride &&
    isReplyPayloadSessionWriterDeliveryAuthorized(owner.payload, current)
  );
}

function readCurrent(owner: ModelNoticePublication): InternalSessionEntry | undefined {
  const target = owner.transcript;
  return target
    ? loadSessionEntryReadOnly({ ...target.scope, readConsistency: "latest" })
    : undefined;
}

function prependNoticeText(message: Record<string, unknown>, notice: string) {
  const prependText = (value: unknown) => {
    const blocks = Array.isArray(value) ? value : [];
    let inserted = false;
    const content: unknown[] = [];
    for (const block of blocks) {
      const record = asOptionalRecord(block);
      if (inserted || record?.type !== "text" || typeof record.text !== "string") {
        content.push(block);
        continue;
      }
      inserted = true;
      const { textSignature: _textSignature, ...rest } = record;
      content.push({ ...rest, text: record.text ? `${notice}\n\n${record.text}` : notice });
    }
    return inserted ? content : [{ type: "text", text: notice }, ...content];
  };
  return {
    ...message,
    content: prependText(message.content),
    ...(Array.isArray(message[ASSISTANT_DISPLAY_CONTENT_FIELD])
      ? { [ASSISTANT_DISPLAY_CONTENT_FIELD]: prependText(message[ASSISTANT_DISPLAY_CONTENT_FIELD]) }
      : {}),
  };
}

/** Gateway media preparation and channel acknowledgments share this exact-row publication. */
export async function persistModelNoticeTranscript(
  payload: ReplyPayload,
  options: {
    rewriteMessage?: (message: Record<string, unknown>) => Record<string, unknown>;
    transcript?: ModelNoticeTranscript;
  } = {},
): Promise<RewriteResult | undefined> {
  const owner = publicationFor(payload);
  if (!owner) {
    return undefined;
  }
  owner.payload = payload;
  owner.transcript ??= options.transcript;
  if (owner.pending) {
    return owner.pending;
  }
  if (owner.persisted !== undefined) {
    return owner.persisted;
  }
  const persist = async (): Promise<RewriteResult> => {
    const target = owner.transcript;
    const metadata = getReplyPayloadMetadata(payload);
    const ownedKey = metadata?.assistantTranscriptOwned
      ? metadata.assistantTranscriptIdempotencyKey?.trim()
      : undefined;
    const identity = metadata?.assistantTranscriptEntryId
      ? { kind: "entry" as const, id: metadata.assistantTranscriptEntryId }
      : ownedKey
        ? { kind: "idempotency" as const, key: ownedKey }
        : undefined;
    if (
      !target ||
      target.start.sessionId !== target.scope.sessionId ||
      !identity ||
      payload.isError ||
      !payload.text ||
      metadata?.sourceReplyTranscriptMirror?.transcriptWriteBlocked ||
      !isCurrent(owner, readCurrent(owner))
    ) {
      log.warn(
        "Recovery notice has no current assistant transcript identity; it was not saved and no notice receipt was recorded.",
      );
      return null;
    }
    const rewritten = await rewriteAssistantTranscriptMessageByTurnIdentity({
      afterSeq: target.start.afterSeq,
      expectedGeneration: target.start.generation,
      identity,
      mediaUrls: metadata?.assistantTranscriptMediaUrls ?? [],
      scope: target.scope,
      canCommit: (current) => isCurrent(owner, current),
      rewriteMessage:
        options.rewriteMessage ?? ((message) => prependNoticeText(message, owner.notice)),
    });
    if (!rewritten) {
      log.warn(
        "Recovery notice transcript changed before persistence; no notice receipt was recorded.",
      );
      return null;
    }
    const published = await publishAssistantTranscriptRewrite({
      scope: target.scope,
      rewritten: [rewritten],
      canCommit: (current) => isCurrent(owner, current),
    });
    if (!published) {
      log.warn(
        "Recovery notice transcript publication became stale; no notice receipt was recorded.",
      );
      return null;
    }
    return rewritten;
  };
  owner.pending = persist();
  owner.persisted = await owner.pending;
  return owner.persisted;
}

/** Composed notices retain one callback and persist their final combined text once. */
export function bindModelNoticePublication(params: {
  original: ReplyPayload;
  payload: ReplyPayload;
  notice: string;
  transcript?: ModelNoticeTranscript;
  recordReceipt?: (
    canCommit: (current: InternalSessionEntry | undefined) => boolean,
  ) => Promise<void>;
}): void {
  const existing = publicationFor(params.original);
  if (existing) {
    existing.payload = params.payload;
    existing.notice = `${params.notice}\n\n${existing.notice}`;
    return;
  }
  const previousSuccess = getReplyPayloadMetadata(params.original)?.onFinalDeliverySuccess;
  let acknowledged = false;
  let delivered = false;
  const owner: ModelNoticePublication = {
    payload: params.payload,
    notice: params.notice,
    transcript: params.transcript,
    deferred: false,
    publication: createDeferredCore(),
    acknowledge: async () => {
      if (acknowledged) {
        return;
      }
      if (!delivered) {
        await previousSuccess?.();
        delivered = true;
      }
      const rewritten = await persistModelNoticeTranscript(owner.payload);
      const transcript = owner.transcript;
      if (
        !rewritten ||
        !transcript ||
        !isCurrent(owner, readCurrent(owner)) ||
        readSessionTranscriptWatermark(transcript.scope).generation !== rewritten.generation
      ) {
        return;
      }
      await params.recordReceipt?.(
        (current) =>
          isCurrent(owner, current) &&
          readSessionTranscriptWatermark(transcript.scope).generation === rewritten.generation,
      );
      acknowledged = true;
    },
  };
  const onFinalDeliverySuccess = async () => {
    if (!owner.deferred) {
      await owner.acknowledge();
    }
  };
  publications.set(onFinalDeliverySuccess, owner);
  setReplyPayloadMetadata(params.payload, { onFinalDeliverySuccess });
}

export function deferModelPolicyNoticeAcknowledgment(payload: ReplyPayload): void {
  const owner = publicationFor(payload);
  if (owner) {
    owner.deferred = true;
  }
}

export function waitForModelPolicyNoticePublication(
  payload: ReplyPayload,
): Promise<void> | undefined {
  const owner = publicationFor(payload);
  return owner?.deferred ? owner.publication.promise : undefined;
}

export async function settleModelPolicyNoticePublication(
  payload: ReplyPayload,
  delivered: boolean,
): Promise<void> {
  const owner = publicationFor(payload);
  if (!owner?.deferred) {
    return;
  }
  try {
    if (delivered) {
      await owner.acknowledge();
    }
  } finally {
    owner.publication.resolve();
  }
}
