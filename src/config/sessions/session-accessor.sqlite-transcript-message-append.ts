import { randomUUID } from "node:crypto";
import { resolveTimestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readSqliteNativeMutationRevision } from "../../infra/sqlite-schema-facts.js";
import { canonicalizePersistedUserMessageMedia } from "../../media/media-facts.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  SessionTranscriptWriteScope,
  TranscriptMessageAppendOptions,
  TranscriptMessageAppendResult,
} from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import {
  consumeSessionPendingInput,
  resolveSessionPendingInputAppend,
} from "./session-accessor.sqlite-pending-inputs.js";
import { readTranscriptIdentityByEventId } from "./session-accessor.sqlite-read.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope.js";
import {
  readActiveTranscriptEntryAnchorInTransaction,
  readTranscriptMessageAppendMetadataInTransaction,
} from "./session-accessor.sqlite-transcript-anchor.js";
import { ensureTranscriptHeader } from "./session-accessor.sqlite-transcript-header.js";
import type { PreparedTranscriptMessageAppend } from "./session-accessor.sqlite-transcript-message-append.types.js";
import {
  isTranscriptEntryOnActivePathInTransaction,
  resolveTranscriptMessageAppendParent,
} from "./session-accessor.sqlite-transcript-parent.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import {
  appendTranscriptEventInTransaction,
  readTranscriptMessageByEventId,
  readTranscriptMessageByScopedIdempotencyKey,
  sanitizeTranscriptMessageForStorage,
} from "./session-accessor.sqlite-transcript-store.js";
import { SqliteTranscriptMutationConflictError } from "./session-mutation-conflict-error.js";
import {
  readTranscriptAppendPostimage,
  retainTranscriptAppendPostimage,
} from "./session-transcript-append-postimage.js";
import { normalizeTranscriptJsonValue } from "./transcript-json.js";
import { messagesMatchForIdempotentReplay } from "./transcript-message-equality.js";
import { readMessageIdempotencyKey } from "./transcript-message-identity.js";
import { prepareTranscriptPayloadForReuse } from "./transcript-payload.js";

export type { PreparedTranscriptMessageAppend } from "./session-accessor.sqlite-transcript-message-append.types.js";

type TranscriptMessageCommit<TMessage> = {
  result: TranscriptMessageAppendResult<TMessage>;
  visibleTailEntryId?: string;
};

class TranscriptTurnAdmissionConflictError extends Error {
  constructor(idempotencyKey: string) {
    super(`Transcript idempotency key "${idempotencyKey}" conflicts with the admitted message.`);
    this.name = "TranscriptTurnAdmissionConflictError";
  }
}

type TranscriptMessageEnvelope = {
  type: "message";
  id: string;
  parentId: string | null;
  appendMode?: "side";
  timestamp: string;
};

function serializePreparedMessageEvent(envelope: TranscriptMessageEnvelope, messageJson: string) {
  return `${JSON.stringify(envelope).slice(0, -1)},"message":${messageJson}}`;
}

/** The append owner retains its canonical message and storage bytes across retries. */
export function prepareTranscriptMessageAppend<TMessage extends object>(
  options: Pick<TranscriptMessageAppendOptions<TMessage>, "message" | "config">,
  candidate?: {
    scope: SessionTranscriptWriteScope;
    envelope: TranscriptMessageEnvelope;
  },
): PreparedTranscriptMessageAppend<TMessage> | undefined {
  if (!isRecord(options.message) || options.message.role === "user") {
    // Pending user custody retains its transaction-owned preparation.
    return undefined;
  }
  const prepared = prepareTranscriptMessageAppendForWorker(options);
  if (
    !candidate ||
    (options.message.role !== "assistant" && options.message.role !== "toolResult")
  ) {
    return prepared;
  }
  const eventJson = serializePreparedMessageEvent(candidate.envelope, prepared.messageJson);
  const read = withOpenClawAgentDatabaseReadOnly(
    ({ db }) =>
      prepareTranscriptPayloadForReuse(db, eventJson, {
        ...candidate.envelope,
        message: prepared.persistedMessage,
      }),
    toDatabaseOptions(resolveSqliteTranscriptScope(candidate.scope)),
  );
  return read.found ? { ...prepared, physicalPayload: read.value } : prepared;
}

/** Transcript normalization stays on the host; physical payload preparation belongs to the writer. */
export function prepareTranscriptMessageAppendForWorker<TMessage extends object>(
  options: Pick<TranscriptMessageAppendOptions<TMessage>, "message" | "config">,
): PreparedTranscriptMessageAppend<TMessage> {
  const message = sanitizeTranscriptMessageForStorage(options.message);
  const persistedMessage = normalizeTranscriptJsonValue(
    canonicalizePersistedUserMessageMedia(message).message,
    "",
  ) as TMessage; // SAFETY: JSON normalization preserves the admitted message's storage shape.
  return { messageJson: JSON.stringify(persistedMessage), persistedMessage };
}

export function appendTranscriptMessageInTransaction<TMessage>(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  options: TranscriptMessageAppendOptions<TMessage> & {
    appendMode?: "side";
  },
  preparedMessage?: PreparedTranscriptMessageAppend<TMessage>,
  projection?: { scheduleProjectionReconcile?: boolean; onProjectionReconcileNeeded?: () => void },
): TranscriptMessageCommit<TMessage> | undefined {
  const pending = resolveSessionPendingInputAppend(database, resolved, options.message);
  // Accepted input already owns its hook and normalization decision. A host-prepared
  // candidate must never replace those bytes during promotion or terminal replay.
  const storagePreparation = pending ? undefined : preparedMessage;
  if (
    pending &&
    readSessionEntryRow(database, resolved.sessionKey)?.entry.sessionId !== resolved.sessionId
  ) {
    throw new Error("Pending input session changed before transcript promotion");
  }
  const serializeForStorage = (message: TMessage): TMessage =>
    storagePreparation?.persistedMessage ?? sanitizeTranscriptMessageForStorage(message);
  const readAnchor = (params: {
    message: unknown;
    messageId: string;
  }): TranscriptMessageAppendResult<TMessage>["anchor"] =>
    readActiveTranscriptEntryAnchorInTransaction({
      database,
      resolved,
      entryId: params.messageId,
      message: params.message,
    });
  const existingAppendResult = (found: { message: unknown; messageId: string }) => {
    const anchor = readAnchor(found);
    if (pending) {
      if (
        found.messageId !== pending.inputId ||
        !messagesMatchForIdempotentReplay(found.message, pending.message)
      ) {
        throw new TranscriptTurnAdmissionConflictError(pending.inputId);
      }
      // A consumed receipt permits terminal mirroring only while its exact user
      // remains on the active path; it cannot revive a replaced transcript branch.
      if (
        !anchor &&
        !isTranscriptEntryOnActivePathInTransaction(database, resolved.sessionId, found.messageId)
      ) {
        throw new Error("Pending input is no longer active in its admitted transcript");
      }
      consumeSessionPendingInput(database, pending);
    }
    return {
      result: {
        appended: false as const,
        ...(anchor ? { anchor } : {}),
        effectiveParentId:
          !pending && anchor
            ? anchor.effectiveParentId
            : (readTranscriptIdentityByEventId(database, resolved.sessionId, found.messageId)
                ?.parentId ?? null),
        message: found.message as TMessage,
        messageId: found.messageId,
      },
    };
  };
  const idempotencyKey = readMessageIdempotencyKey(options.message);
  if (idempotencyKey && options.idempotencyLookup !== "caller-checked") {
    const existing = readTranscriptMessageByScopedIdempotencyKey(
      database,
      resolved,
      idempotencyKey,
      options.idempotencyLookup,
    );
    if (existing) {
      if (
        !options.prepareMessageAfterIdempotencyCheck &&
        !messagesMatchForIdempotentReplay(
          existing.message,
          pending?.message ?? serializeForStorage(options.message),
        )
      ) {
        throw new TranscriptTurnAdmissionConflictError(idempotencyKey);
      }
      return existingAppendResult(existing);
    }
  }

  if (pending?.alreadyPromoted && !pending.stageRelocation) {
    const committed = readTranscriptMessageByEventId(database, resolved, pending.inputId);
    if (!committed) {
      throw new Error("Pending input custody ended before transcript promotion");
    }
    return existingAppendResult(committed);
  }
  // Pending input already passed the hook and normalization before acknowledgment.
  const prepared = pending
    ? (pending.message as TMessage) // SAFETY: exact private custody supplies this keyed user's approved storage bytes.
    : options.prepareMessageAfterIdempotencyCheck
      ? options.prepareMessageAfterIdempotencyCheck(options.message)
      : options.message;
  if (prepared === undefined) {
    return undefined;
  }

  if (!pending && options.expectedTranscript) {
    const current = readTranscriptContextVersionInTransaction(database, resolved.sessionId);
    const expected = options.expectedTranscript;
    if (
      current.generation !== expected.generation ||
      current.rawSeq !== expected.rawSeq ||
      current.updatedAt !== expected.updatedAt
    ) {
      throw new SqliteTranscriptMutationConflictError(resolved.sessionId);
    }
  }

  const messageId =
    pending && !pending.alreadyPromoted ? pending.inputId : (options.eventId ?? randomUUID());
  const now = options.now ?? Date.now();
  const finalMessage = pending ? prepared : serializeForStorage(prepared);
  if (!pending) {
    // Accepted custody and replay retain their original decision. Fresh input
    // must still belong to its captured owner before any transcript write.
    options.beforeFreshMessageCommit?.();
  }
  ensureTranscriptHeader(database, resolved, options.cwd, projection);
  const parentId = resolveTranscriptMessageAppendParent(database, resolved.sessionId, options);
  const event = {
    type: "message" as const,
    id: messageId,
    parentId: parentId ?? null,
    ...(options.appendMode ? { appendMode: options.appendMode } : {}),
    timestamp: resolveTimestampMsToIsoString(now),
    message: storagePreparation?.persistedMessage ?? finalMessage,
  };
  let eventJson: string | undefined;
  if (storagePreparation) {
    // The parent is authoritative only after BEGIN; serialize just its small envelope here.
    const { message: _message, ...envelope } = event;
    eventJson = serializePreparedMessageEvent(envelope, storagePreparation.messageJson);
  }
  const appended = appendTranscriptEventInTransaction(database, resolved, event, {
    ...projection,
    eventJson,
    preparedPayload: storagePreparation?.physicalPayload,
    idempotencyKeyMode:
      options.idempotencyLookup === "caller-checked"
        ? "relocate-owner"
        : options.idempotencyLookup === "scan-assistant"
          ? "preserve-owner"
          : "dedupe",
  });
  if (!appended) {
    const existing =
      (idempotencyKey && options.idempotencyLookup !== "caller-checked"
        ? readTranscriptMessageByScopedIdempotencyKey(
            database,
            resolved,
            idempotencyKey,
            options.idempotencyLookup,
          )
        : undefined) ?? readTranscriptMessageByEventId(database, resolved, messageId);
    if (existing) {
      if (
        !options.prepareMessageAfterIdempotencyCheck &&
        !messagesMatchForIdempotentReplay(existing.message, finalMessage)
      ) {
        throw new TranscriptTurnAdmissionConflictError(idempotencyKey ?? `event:${messageId}`);
      }
      return existingAppendResult(existing);
    }
    throw new Error(`SQLite transcript append did not insert message ${messageId}.`);
  }
  const persistedMessage =
    storagePreparation?.persistedMessage ??
    // SAFETY: Receipt custody comes from this event's exact committed JSON after storage normalization.
    (JSON.parse(appended) as typeof event).message;
  const metadata = readTranscriptMessageAppendMetadataInTransaction({
    database,
    resolved,
    entryId: messageId,
    message: persistedMessage,
  });
  const { anchor } = metadata;
  const revision = readSqliteNativeMutationRevision(database.db);
  if (pending) {
    if (pending.stageRelocation) {
      pending.stageRelocation(messageId);
    } else {
      consumeSessionPendingInput(database, pending);
    }
  }
  return retainTranscriptAppendPostimage(
    {
      result: {
        appended: true,
        ...(anchor ? { anchor } : {}),
        effectiveParentId: parentId ?? null,
        message: persistedMessage,
        messageId,
      },
      ...(metadata.visibleTailEntryId !== undefined &&
      revision !== undefined &&
      readSqliteNativeMutationRevision(database.db) === revision
        ? { visibleTailEntryId: metadata.visibleTailEntryId }
        : {}),
    },
    readTranscriptAppendPostimage(metadata),
  );
}
