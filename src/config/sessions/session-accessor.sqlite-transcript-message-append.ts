import { randomUUID } from "node:crypto";
import { resolveTimestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AssistantMessage } from "../../llm/types.js";
import { canonicalizePersistedUserMessageMedia } from "../../media/media-facts.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { getCliHistoryWriter } from "./cli-history-boundary.js";
import type {
  TranscriptMessageAppendOptions,
  TranscriptMessageAppendResult,
} from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import {
  consumeSessionPendingInput,
  resolveSessionPendingInputAppend,
} from "./session-accessor.sqlite-pending-inputs.js";
import { readTranscriptIdentityByEventId } from "./session-accessor.sqlite-read.js";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import {
  createTranscriptMessageAppendMetadataFromWrites,
  readActiveTranscriptEntryAnchorInTransaction,
  readTranscriptMessageAppendMetadataInTransaction,
  readTranscriptMessageAppendMetadataBatchInTransaction,
} from "./session-accessor.sqlite-transcript-anchor.js";
import type { TranscriptAppendCursor } from "./session-accessor.sqlite-transcript-append.types.js";
import { createTranscriptAppendBatch } from "./session-accessor.sqlite-transcript-batch.js";
import { ensureTranscriptHeader } from "./session-accessor.sqlite-transcript-header.js";
import {
  readTranscriptMessageByEventId,
  readTranscriptMessageByScopedIdempotencyKey,
} from "./session-accessor.sqlite-transcript-identity.js";
import type { PreparedTranscriptMessageAppend } from "./session-accessor.sqlite-transcript-message-append.types.js";
import {
  isTranscriptEntryOnActivePathInTransaction,
  resolveTranscriptMessageAppendParent,
} from "./session-accessor.sqlite-transcript-parent.js";
import {
  readTranscriptContextVersionInTransaction,
  readTranscriptAppendStateInTransaction,
} from "./session-accessor.sqlite-transcript-state.js";
import {
  appendTranscriptEventInTransaction,
  sanitizeTranscriptMessageForStorage,
} from "./session-accessor.sqlite-transcript-store.js";
import type { SessionTranscriptTurnMessageAppend } from "./session-accessor.types.js";
import { readSessionActorTransactionState } from "./session-actor-transaction.js";
import { SqliteTranscriptMutationConflictError } from "./session-mutation-conflict-error.js";
import {
  readTranscriptAppendPostimage,
  retainTranscriptAppendPostimage,
} from "./session-transcript-append-postimage.js";
import type { SessionTranscriptAuthority } from "./session-transcript-authority.types.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";
import { createSessionTranscriptHeader } from "./transcript-header.js";
import { normalizeTranscriptJsonValue } from "./transcript-json.js";
import { messagesMatchForIdempotentReplay } from "./transcript-message-equality.js";
import { readMessageIdempotencyKey } from "./transcript-message-identity.js";

export type { PreparedTranscriptMessageAppend } from "./session-accessor.sqlite-transcript-message-append.types.js";

type TranscriptMessageCommit<TMessage> = {
  result: TranscriptMessageAppendResult<TMessage>;
  visibleTailEntryId?: string;
};

type TranscriptMessageTurnContext = {
  cursor: TranscriptAppendCursor;
  headerEnsured: boolean;
  parentId?: string | null;
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
  /** Entry id this branch-rewrite copy replaces; absent on ordinary appends. */
  supersedesEntryId?: string;
  timestamp: string;
};

function serializePreparedMessageEvent(envelope: TranscriptMessageEnvelope, messageJson: string) {
  return `${JSON.stringify(envelope).slice(0, -1)},"message":${messageJson}}`;
}

/** The append owner retains its canonical message and storage bytes across retries. */
export function prepareTranscriptMessageAppend<TMessage extends object>(
  options: Pick<TranscriptMessageAppendOptions<TMessage>, "message" | "config">,
): PreparedTranscriptMessageAppend<TMessage> | undefined {
  if (!isRecord(options.message) || options.message.role === "user") {
    // Pending user custody retains its transaction-owned preparation.
    return undefined;
  }
  return prepareTranscriptMessageAppendForWorker(options);
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

function createTranscriptMessageEvent<TMessage>(params: {
  message: TMessage;
  messageId: string;
  parentId: string | null;
  now: number;
  appendMode?: "side";
  supersedesEntryId?: string;
}) {
  return {
    type: "message" as const,
    id: params.messageId,
    parentId: params.parentId,
    ...(params.appendMode ? { appendMode: params.appendMode } : {}),
    ...(params.supersedesEntryId ? { supersedesEntryId: params.supersedesEntryId } : {}),
    timestamp: resolveTimestampMsToIsoString(params.now),
    message: params.message,
  };
}

/** A new session commits these prepared bytes with its row through the creation owner. */
export function prepareInitialAssistantTranscript(params: {
  sessionId: string;
  cwd?: string;
  message: AssistantMessage;
  idempotencyKey?: string;
}) {
  const prepared = prepareTranscriptMessageAppendForWorker({
    message: {
      ...params.message,
      ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    },
  });
  const now = Date.now();
  return [
    createSessionTranscriptHeader({
      sessionId: params.sessionId,
      cwd: params.cwd,
      timestamp: resolveTimestampMsToIsoString(now),
    }),
    createTranscriptMessageEvent({
      message: prepared.persistedMessage,
      messageId: randomUUID(),
      parentId: null,
      now,
    }),
  ];
}

/** Fresh linear turns share writes; callbacks, custody, branches, and replay retain their path. */
export function appendFreshLinearTranscriptMessagesInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  messages: readonly SessionTranscriptTurnMessageAppend[],
  projection?: Parameters<typeof appendTranscriptMessageInTransaction>[4],
):
  | {
      commits: TranscriptMessageCommit<unknown>[];
      sequences: (number | undefined)[];
      windowUpdatedAt?: number;
      version?: SessionTranscriptContextVersion;
    }
  | undefined {
  if (
    messages.length < 2 ||
    readSessionActorTransactionState(database, resolved) ||
    getCliHistoryWriter({ ...resolved, storePath: database.path }) ||
    messages.some(
      (append) =>
        !isRecord(append.message) ||
        append.message.idempotencyKey !== undefined ||
        (append.eventId !== undefined &&
          (!append.eventId || append.eventId !== append.eventId.trim())) ||
        append.parentId !== undefined ||
        append.appendIntent !== undefined ||
        append.idempotencyLookup !== undefined ||
        append.expectedTranscript !== undefined ||
        append.expectedMutationAt !== undefined ||
        append.useRawWhenLinear !== undefined ||
        append.shouldAppend !== undefined ||
        append.shouldAppendInTransaction !== undefined ||
        append.predicate !== undefined ||
        append.workerPreparation !== undefined ||
        append.preparation !== undefined ||
        append.prepareMessageAfterIdempotencyCheck !== undefined ||
        append.beforeFreshMessageCommit !== undefined,
    )
  ) {
    return undefined;
  }
  const eventIds = messages.map((append) => append.eventId ?? randomUUID());
  if (new Set(eventIds).size !== eventIds.length) {
    return undefined;
  }
  // Only caller-supplied identities need probing; this call just minted the other UUIDs.
  const batch = createTranscriptAppendBatch(
    database,
    resolved,
    messages.flatMap((append, index) =>
      append.eventId === undefined
        ? []
        : [
            {
              type: "message",
              id: eventIds[index]!,
              message: append.message,
            },
          ],
    ),
    projection ?? {},
  );
  if (batch.cursor.batch?.knownEventIds.size) {
    return undefined;
  }
  const context: TranscriptMessageTurnContext = { cursor: batch.cursor, headerEnsured: false };
  const commits: TranscriptMessageCommit<unknown>[] = [];
  let adjustedTime = -1;
  let publicationAssistant: SessionTranscriptAuthority["lastAssistantMessage"];
  let projectionNeedsRebuild = false;
  const deferredProjection = {
    scheduleProjectionReconcile: false,
    onProjectionReconcileNeeded: () => {
      projectionNeedsRebuild = true;
    },
  };
  let completed = false;
  let version: SessionTranscriptContextVersion | undefined;
  const positions: { seq: number; messagePosition: number }[] = [];
  try {
    for (const [index, append] of messages.entries()) {
      const committed = appendTranscriptMessageInTransaction(
        database,
        resolved,
        { ...append, eventId: eventIds[index]! },
        undefined,
        deferredProjection,
        context,
      );
      if (!committed?.result.appended) {
        throw new Error("Fresh transcript turn reused an existing event identity");
      }
      commits.push(committed);
      const postimage = context.cursor.appendToIndex?.readPostimage();
      const seq = context.cursor.nextSeq === undefined ? undefined : context.cursor.nextSeq - 1;
      if (seq !== undefined && postimage?.state.indexedSeq === seq) {
        positions.push({ seq, messagePosition: postimage.state.activeMessageCount - 1 });
      }
      const assistant = context.cursor.rowTranscript?.lastAssistantMessage;
      // Disk rows keep the per-message sentinel; the one publication carries
      // the assistant fact from earlier messages in this same transaction.
      if (assistant !== "unchanged" || commits.length === 1) {
        publicationAssistant = assistant;
      } else if (publicationAssistant === undefined) {
        publicationAssistant = "unknown";
      }
      adjustedTime = Math.max(adjustedTime + 1, Date.now());
      batch.flushFullChunk();
    }
    completed = true;
  } finally {
    version = batch.settle(completed, commits.length, projectionNeedsRebuild, {
      steps: commits.length,
      adjustedTime,
      publicationAssistant,
    });
  }
  if (projectionNeedsRebuild) {
    projection?.onProjectionReconcileNeeded?.();
  }
  const postimage = context.cursor.appendToIndex?.readPostimage();
  const metadata =
    !projectionNeedsRebuild &&
    version?.generation &&
    version.rawSeq !== null &&
    postimage?.flushed &&
    postimage.state.indexedSeq === version.rawSeq &&
    positions.length === commits.length
      ? createTranscriptMessageAppendMetadataFromWrites(
          database,
          resolved,
          commits.map(({ result }, index) => ({
            ...result,
            parentId: result.effectiveParentId ?? null,
            ...positions[index]!,
          })),
          { ...version, generation: version.generation, rawSeq: version.rawSeq },
        )
      : readTranscriptMessageAppendMetadataBatchInTransaction(
          database,
          resolved,
          commits.map(({ result }) => result),
        );
  for (const committed of commits) {
    const facts = metadata.get(committed.result.messageId);
    if (facts?.anchor) {
      committed.result.anchor = facts.anchor;
    }
    if (facts?.visibleTailEntryId !== undefined) {
      committed.visibleTailEntryId = facts.visibleTailEntryId;
    }
    retainTranscriptAppendPostimage(committed, readTranscriptAppendPostimage(facts));
  }
  return {
    commits,
    windowUpdatedAt: context.cursor.windowUpdatedAt,
    version: metadata.get(commits.at(-1)!.result.messageId)?.version,
    sequences: commits.map(({ result }) =>
      result.anchor ? result.anchor.activeMessagePosition + 1 : undefined,
    ),
  };
}

export function appendTranscriptMessageInTransaction<TMessage>(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  options: TranscriptMessageAppendOptions<TMessage> & {
    appendMode?: "side";
    supersedesEntryId?: string;
  },
  preparedMessage?: PreparedTranscriptMessageAppend<TMessage>,
  projection?: { scheduleProjectionReconcile?: boolean; onProjectionReconcileNeeded?: () => void },
  turn?: TranscriptMessageTurnContext,
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
  const cursor: TranscriptAppendCursor | undefined =
    turn?.cursor ?? (readSessionActorTransactionState(database, resolved) ? undefined : {});
  if (cursor && !cursor.initialized && !cursor.initialState) {
    cursor.initialState = readTranscriptAppendStateInTransaction(database, resolved, true);
  }
  if (!turn?.headerEnsured) {
    ensureTranscriptHeader(database, resolved, options.cwd, projection, cursor);
    if (turn) {
      turn.headerEnsured = true;
    }
  }
  if (turn && turn.parentId === undefined) {
    turn.parentId = resolveTranscriptMessageAppendParent(
      database,
      resolved.sessionId,
      options,
      cursor?.initialState?.parent,
    );
  }
  const parentId = turn
    ? turn.parentId
    : resolveTranscriptMessageAppendParent(
        database,
        resolved.sessionId,
        options,
        cursor?.initialState?.parent,
      );
  const event = createTranscriptMessageEvent({
    messageId,
    parentId: parentId ?? null,
    appendMode: options.appendMode,
    supersedesEntryId: options.supersedesEntryId,
    now,
    message: storagePreparation?.persistedMessage ?? finalMessage,
  });
  let eventJson: string | undefined;
  if (storagePreparation) {
    // The parent is authoritative only after BEGIN; serialize just its small envelope here.
    const { message: _message, ...envelope } = event;
    eventJson = serializePreparedMessageEvent(envelope, storagePreparation.messageJson);
  }
  const appended = appendTranscriptEventInTransaction(
    database,
    resolved,
    event,
    {
      ...projection,
      ...(turn ? { touchMutation: false, independentMessageProjection: true } : {}),
      eventJson,
      preparedPayload: storagePreparation?.physicalPayload,
      idempotencyKeyMode:
        options.idempotencyLookup === "caller-checked"
          ? "relocate-owner"
          : options.idempotencyLookup === "scan-assistant"
            ? "preserve-owner"
            : "dedupe",
    },
    cursor,
  );
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
  if (turn) {
    turn.parentId = messageId;
  }
  const metadata = turn
    ? undefined
    : readTranscriptMessageAppendMetadataInTransaction({
        database,
        resolved,
        entryId: messageId,
        message: persistedMessage,
      });
  const anchor = metadata?.anchor;
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
      ...(metadata?.visibleTailEntryId !== undefined
        ? { visibleTailEntryId: metadata.visibleTailEntryId }
        : {}),
    },
    readTranscriptAppendPostimage(metadata),
  );
}
