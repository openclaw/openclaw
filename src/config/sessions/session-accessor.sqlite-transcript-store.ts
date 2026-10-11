import type { SessionTreeEntry } from "@openclaw/agent-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parseCompactionDetails } from "../../../packages/agent-core/src/harness/compaction/compaction-details.js";
import type { AgentMessage } from "../../agents/runtime/index.js";
import { sanitizeTranscriptMessage } from "../../agents/transcript-sanitize.js";
import { executeSqliteQuerySync, prepareSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  sqliteSessionIdWriteScope,
  withoutSqliteDatabaseWriteScope,
  withSqliteDatabaseWriteScope,
} from "../../infra/sqlite-database-admission.js";
import {
  deferOpenClawAgentPostCommitPublication,
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { advanceCliHistoryBoundaryInTransaction } from "./session-accessor.sqlite-cli-history-boundary.js";
import type {
  TranscriptEvent,
  TranscriptMessageAppendOptions,
} from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow, writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import {
  createTranscriptIdentityReader,
  findAssistantTranscriptEventInDatabase,
  readEventTimestamp,
  readTranscriptEventId,
  readTranscriptEventMessage,
  readTranscriptIdentityByEventId,
} from "./session-accessor.sqlite-read.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope.js";
import {
  createTranscriptIdentityInserter,
  readIdempotencyKeyOwner,
  readTranscriptEventIdentity,
  readTranscriptMessageByIdentity,
} from "./session-accessor.sqlite-transcript-identity.js";
import {
  advanceTranscriptMutationAtInTransaction,
  deleteTranscriptEventsInTransaction,
  ensureTranscriptGenerationInTransaction,
  ensureTranscriptSessionRoot,
  pruneTranscriptReactionsInTransaction,
  readTranscriptGenerationInTransaction,
  readTranscriptMutationStateInTransaction,
  readNextTranscriptSeq,
  rotateTranscriptGenerationInTransaction,
  touchTranscriptMutationInTransaction,
} from "./session-accessor.sqlite-transcript-state.js";
import type { SessionTranscriptRuntimeScope } from "./session-accessor.types.js";
import { readSessionActorTransactionState } from "./session-actor-transaction.js";
import { readHotSessionTranscriptSnapshot } from "./session-cold-storage-read.js";
import {
  createTranscriptIndexAppenderInTransaction,
  deleteSessionTranscriptIndexInTransaction,
  markSessionTranscriptIndexDirtyInTransaction,
  reconcileSessionTranscriptIndexInTransaction,
  sessionTranscriptIndexNeedsReconcile,
  shouldRebuildSessionTranscriptIndexSynchronously,
} from "./session-transcript-index.js";
import { startSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import { copyRetainedTranscriptPayload } from "./session-transcript-retained-data.js";
import {
  isSteerConfirmationRewrite,
  transcriptRewritePreservesProjection,
} from "./session-transcript-rewrite-effects.js";
import { canonicalizeTranscriptEventMedia } from "./transcript-event-media.js";
import {
  createTranscriptEventInserter,
  createTranscriptPayloadUpdater,
  prepareTranscriptPayload,
  transcriptEventJsonSql,
  type PreparedTranscriptPayload,
} from "./transcript-payload.js";

type TranscriptAppendOptions = {
  /** Exact event bytes, including canonical media, prepared by the message append owner. */
  eventJson?: string;
  preparedPayload?: PreparedTranscriptPayload;
  allowStoredAlias?: boolean;
  onPlaceholderInserted?: (placeholder: { sessionKey: string; sessionId: string }) => void;
  idempotencyKeyMode?: "dedupe" | "preserve-owner" | "relocate-owner";
  onProjectionReconcileNeeded?: () => void;
  scheduleProjectionReconcile?: boolean;
  touchMutation?: boolean;
};

type TranscriptAppendCursor = {
  initialized?: boolean;
  readIdentity?: ReturnType<typeof createTranscriptIdentityReader>;
  nextSeq?: number;
  appendToIndex?: ReturnType<typeof createTranscriptIndexAppenderInTransaction>;
  updateWindow?: (createdAt: number) => unknown;
  insertEvent?: ReturnType<typeof createTranscriptEventInserter>;
  insertIdentity?: ReturnType<typeof createTranscriptIdentityInserter>;
};

/** Inserts exact transcript rows without mutating the forward-only projection. */
export function insertTranscriptRowsWithoutProjectionInTransaction(
  database: OpenClawAgentDatabase,
  sessionId: string,
  rows: readonly {
    event: TranscriptEvent;
    seq: number;
    createdAt: number;
    messageIdempotencyKey?: string | null;
    storedEventSeq?: number;
  }[],
  reservedMessageIdempotencyKeys: ReadonlySet<string> = new Set(),
): void {
  return withSqliteDatabaseWriteScope(database.db, [sqliteSessionIdWriteScope(sessionId)], () => {
    const insertEvent = createTranscriptEventInserter(database.db, sessionId);
    const insertIdentity = createTranscriptIdentityInserter(database, sessionId, false);
    for (const row of rows) {
      const event = withoutSqliteDatabaseWriteScope(database.db, () =>
        canonicalizeTranscriptEventMedia(row.event),
      );
      if (row.storedEventSeq === undefined) {
        insertEvent({
          seq: row.seq,
          eventJson: withoutSqliteDatabaseWriteScope(database.db, () => JSON.stringify(event)),
          createdAt: row.createdAt,
        });
      } else {
        copyRetainedTranscriptPayload(database, sessionId, row.storedEventSeq, row.seq);
      }
      const identity = readTranscriptEventIdentity(event);
      if (!identity) {
        continue;
      }
      if ("messageIdempotencyKey" in row) {
        identity.messageIdempotencyKey = row.messageIdempotencyKey ?? null;
      } else if (
        identity.messageIdempotencyKey &&
        (reservedMessageIdempotencyKeys.has(identity.messageIdempotencyKey) ||
          readIdempotencyKeyOwner(database, sessionId, identity.messageIdempotencyKey))
      ) {
        identity.messageIdempotencyKey = null;
      }
      insertIdentity({ ...identity, seq: row.seq, createdAt: row.createdAt });
    }
  });
}

/** Returns the exact committed JSON, or false when an existing identity owns the event. */
export function appendTranscriptEventInTransaction(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  event: TranscriptEvent,
  options: TranscriptAppendOptions = {},
  cursor: TranscriptAppendCursor = {},
): string | false {
  const persistedEvent =
    options.eventJson === undefined ? canonicalizeTranscriptEventMedia(event) : event;
  return withSqliteDatabaseWriteScope(
    database.db,
    [scope.sessionKey, sqliteSessionIdWriteScope(scope.sessionId)],
    () => {
      const db = getSessionKysely(database.db);
      const actor = readSessionActorTransactionState(database, scope);
      const createdAt = readEventTimestamp(persistedEvent) ?? Date.now();
      let windowUpdatedAt = createdAt;
      // The existing window can share the final watermark write. Rejected identities
      // still need their recency-only write, without advancing the transcript fence.
      const deferWindowTouch =
        options.touchMutation !== false && Boolean(cursor.initialized || actor?.window);
      const touchWindow = () => {
        cursor.updateWindow ??= prepareSqliteQuerySync<number>(database.db, (parameter) =>
          db
            .updateTable("session_windows")
            .set({ updated_at: parameter((timestamp) => timestamp) })
            .where("session_id", "=", scope.sessionId),
        );
        cursor.updateWindow(createdAt);
        if (actor?.window) {
          actor.window.updated_at = createdAt;
        }
      };
      if (cursor.initialized) {
        // The first attempt established this window and the batch cannot delete it.
        if (!deferWindowTouch) {
          touchWindow();
        }
      } else {
        ensureTranscriptSessionRoot(database, scope, createdAt, {
          allowStoredAlias: options.allowStoredAlias === true,
          onPlaceholderInserted: options.onPlaceholderInserted,
          deferExistingWindowTouch: deferWindowTouch,
        });
        ensureTranscriptGenerationInTransaction(database, scope.sessionId);
        cursor.initialized = true;
      }
      const identity = readTranscriptEventIdentity(persistedEvent);
      if (identity) {
        // Reuse compilation within this batch, but read fresh rows after every append.
        cursor.readIdentity ??= createTranscriptIdentityReader(database, scope.sessionId);
        if (cursor.readIdentity(identity.eventId)) {
          if (deferWindowTouch) {
            touchWindow();
          }
          return false;
        }
      }
      const idempotencyKeyOwner = identity?.messageIdempotencyKey
        ? readIdempotencyKeyOwner(database, scope.sessionId, identity.messageIdempotencyKey)
        : undefined;
      if (idempotencyKeyOwner && options.idempotencyKeyMode === "dedupe") {
        if (deferWindowTouch) {
          touchWindow();
        }
        return false;
      }
      const seq = cursor.nextSeq ?? readNextTranscriptSeq(database, scope.sessionId);
      cursor.insertEvent ??= createTranscriptEventInserter(database.db, scope.sessionId);
      const eventJson =
        options.eventJson ??
        withoutSqliteDatabaseWriteScope(database.db, () => JSON.stringify(persistedEvent));
      cursor.insertEvent({
        seq,
        eventJson,
        createdAt,
        parsedEvent: options.eventJson === undefined ? undefined : persistedEvent,
        preparedPayload: options.preparedPayload,
      });
      if (actor) {
        actor.hot.transcript.version.rawSeq = seq;
        actor.hot.transcript.watermark.maxSeq = seq;
        const stored: unknown = JSON.parse(eventJson);
        actor.transcript.payloads.set(seq, stored);
        // SAFETY: The same canonical event feeds the existing projection and tree codecs.
        actor.transcript.navigation.push({ ...(stored as SessionTreeEntry), seq });
      }
      cursor.nextSeq = seq + 1;
      cursor.appendToIndex ??= createTranscriptIndexAppenderInTransaction(
        database.db,
        scope.sessionId,
      );
      const projectionNeedsRebuild = cursor.appendToIndex({
        seq,
        event: persistedEvent,
        eventId: identity?.eventId ?? null,
        createdAt,
      });
      if (projectionNeedsRebuild) {
        withoutSqliteDatabaseWriteScope(database.db, () => options.onProjectionReconcileNeeded?.());
      }
      if (identity) {
        // Replayed copies take ownership so later retries resolve on the active branch.
        // scan-assistant preserves a colliding user's ownership instead.
        if (idempotencyKeyOwner && options.idempotencyKeyMode === "relocate-owner") {
          executeSqliteQuerySync(
            database.db,
            db
              .updateTable("transcript_event_identities")
              .set({ message_idempotency_key: null })
              .where("session_id", "=", scope.sessionId)
              .where("event_id", "=", idempotencyKeyOwner.eventId),
          );
          const previous = actor?.transcript.identities.get(idempotencyKeyOwner.eventId);
          if (previous) {
            actor?.transcript.identities.set(previous.event_id, {
              ...previous,
              message_idempotency_key: null,
            });
          }
        }
        identity.messageIdempotencyKey =
          idempotencyKeyOwner && options.idempotencyKeyMode !== "relocate-owner"
            ? null
            : identity.messageIdempotencyKey;
        cursor.insertIdentity ??= createTranscriptIdentityInserter(database, scope.sessionId, true);
        cursor.insertIdentity({ ...identity, seq, createdAt });
        actor?.transcript.identities.set(identity.eventId, {
          session_id: scope.sessionId,
          event_id: identity.eventId,
          seq,
          event_type: identity.eventType,
          parent_id: identity.parentId,
          message_idempotency_key: identity.messageIdempotencyKey,
          created_at: createdAt,
        });
      }
      advanceCliHistoryBoundaryInTransaction(database, scope, seq);
      if (
        isRecord(persistedEvent) &&
        persistedEvent.type === "compaction" &&
        parseCompactionDetails(persistedEvent.details)?.qualityDegraded
      ) {
        const entry = readSessionEntryRow(database, scope.sessionKey)?.entry;
        if (entry?.sessionId === scope.sessionId && !entry.compactionQualityDegraded) {
          // A later successful summary cannot recover facts already lost from this history.
          windowUpdatedAt = writeSessionEntry(
            database,
            scope.sessionKey,
            { ...entry, compactionQualityDegraded: true },
            { previousEntry: entry },
          ).updatedAt;
        }
      }
      if (options.touchMutation !== false) {
        touchTranscriptMutationInTransaction(
          database,
          scope.sessionId,
          deferWindowTouch ? windowUpdatedAt : undefined,
        );
      }
      scheduleTranscriptProjectionReconcile(
        database,
        scope.sessionId,
        projectionNeedsRebuild,
        options,
      );
      return eventJson;
    },
  );
}

export function scheduleTranscriptProjectionReconcile(
  database: OpenClawAgentDatabase,
  sessionId: string,
  projectionNeedsRebuild: boolean,
  options: { scheduleProjectionReconcile?: boolean },
): void {
  if (!projectionNeedsRebuild || options.scheduleProjectionReconcile === false) {
    return;
  }
  // Dirty state is durable: a missed post-commit kick is recovered by startup/search reconciliation.
  deferOpenClawAgentPostCommitPublication(database, (databaseOptions) =>
    startSessionTranscriptIndexReconcile({
      ...databaseOptions,
      preferredSessionId: sessionId,
    }),
  );
}

export function appendTranscriptEventsInTransaction(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  events: Iterable<TranscriptEvent, unknown, boolean>,
  options: Omit<TranscriptAppendOptions, "onProjectionReconcileNeeded"> = {},
): number {
  let appended = 0;
  let projectionNeedsRebuild = false;
  // Prepared arrays and the import spool cannot mutate the destination between
  // rows. Sequence and projection facts belong only to this synchronous batch.
  const cursor: TranscriptAppendCursor = {};
  const iterator = events[Symbol.iterator]();
  const appendOptions = {
    ...options,
    onProjectionReconcileNeeded: () => {
      projectionNeedsRebuild = true;
    },
    scheduleProjectionReconcile: false,
    touchMutation: false,
  };
  try {
    let next = iterator.next();
    while (!next.done) {
      const inserted = appendTranscriptEventInTransaction(
        database,
        scope,
        next.value,
        appendOptions,
        cursor,
      );
      if (inserted) {
        appended += 1;
      }
      // Streaming imports acknowledge only inserted rows in their byte-dedupe
      // spool; ordinary array iterators ignore this feedback.
      next = iterator.next(inserted !== false);
    }
  } catch (error) {
    try {
      iterator.return?.();
    } catch {
      // Preserve the append error if iterator cleanup also fails.
    }
    throw error;
  }
  if (appended > 0) {
    if (options.touchMutation !== false) {
      touchTranscriptMutationInTransaction(database, scope.sessionId);
    }
    scheduleTranscriptProjectionReconcile(
      database,
      scope.sessionId,
      projectionNeedsRebuild,
      options,
    );
  }
  return appended;
}

export function replaceSqliteTranscriptEventsInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  events: readonly TranscriptEvent[],
  options: {
    createdAtByIndex?: readonly number[];
    /** Keep maintenance rewrites at their existing recency while invalidating stale projections. */
    preserveSessionWindowRecency?: boolean;
    scheduleProjectionReconcile?: boolean;
    onProjectionReconcileNeeded?: () => void;
  } = {},
): void {
  return withSqliteDatabaseWriteScope(
    database.db,
    [resolved.sessionKey, sqliteSessionIdWriteScope(resolved.sessionId)],
    () => {
      const rebuildSynchronously =
        events.length > 0 &&
        shouldRebuildSessionTranscriptIndexSynchronously(database.db, resolved.sessionId, events);
      const preservedTranscriptUpdatedAt =
        options.preserveSessionWindowRecency === true
          ? readTranscriptMutationStateInTransaction(database, resolved.sessionId).updatedAt
          : undefined;
      const previousGeneration = readTranscriptGenerationInTransaction(
        database,
        resolved.sessionId,
      );
      const deleted = deleteTranscriptEventsInTransaction(database, resolved.sessionId);
      if (events.length === 0) {
        pruneTranscriptReactionsInTransaction(database, resolved);
        deleteSessionTranscriptIndexInTransaction(database.db, resolved.sessionId);
        if (deleted || previousGeneration) {
          rotateTranscriptGenerationInTransaction(database, resolved.sessionId);
          recordTranscriptReplacementMutation(
            database,
            resolved.sessionId,
            preservedTranscriptUpdatedAt,
          );
        }
        return;
      }
      if (!deleted || options.preserveSessionWindowRecency !== true) {
        ensureTranscriptSessionRoot(
          database,
          resolved,
          readEventTimestamp(events[0]) ?? Date.now(),
        );
      }
      if (deleted || previousGeneration) {
        rotateTranscriptGenerationInTransaction(database, resolved.sessionId);
      } else {
        ensureTranscriptGenerationInTransaction(database, resolved.sessionId);
      }
      if (rebuildSynchronously) {
        deleteSessionTranscriptIndexInTransaction(database.db, resolved.sessionId);
      } else {
        // Preserve large old FTS rows; the dirty watermark hides them until worker reconciliation.
        markSessionTranscriptIndexDirtyInTransaction(database.db, resolved.sessionId);
      }
      let seq = 0;
      const seenEventIds = new Set<string>();
      const seenMessageIdempotencyKeys = new Set<string>();
      const insertEvent = createTranscriptEventInserter(database.db, resolved.sessionId);
      const insertIdentity = createTranscriptIdentityInserter(database, resolved.sessionId, false);
      // The reset/dirty transition above owns the initial projection state for this whole batch.
      const appendToIndex = createTranscriptIndexAppenderInTransaction(
        database.db,
        resolved.sessionId,
      );
      for (const [eventIndex, event] of events.entries()) {
        const persistedEvent = withoutSqliteDatabaseWriteScope(database.db, () =>
          canonicalizeTranscriptEventMedia(event),
        );
        const createdAt =
          options.createdAtByIndex?.[eventIndex] ??
          readEventTimestamp(persistedEvent) ??
          Date.now();
        const identity = readTranscriptEventIdentity(persistedEvent);
        if (identity && seenEventIds.has(identity.eventId)) {
          continue;
        }
        insertEvent({
          seq,
          eventJson: withoutSqliteDatabaseWriteScope(database.db, () =>
            JSON.stringify(persistedEvent),
          ),
          createdAt,
        });
        appendToIndex({
          seq,
          event: persistedEvent,
          eventId: identity?.eventId ?? null,
          createdAt,
        });
        if (identity) {
          seenEventIds.add(identity.eventId);
          if (identity.messageIdempotencyKey) {
            if (seenMessageIdempotencyKeys.has(identity.messageIdempotencyKey)) {
              identity.messageIdempotencyKey = null;
            } else {
              seenMessageIdempotencyKeys.add(identity.messageIdempotencyKey);
            }
          }
          insertIdentity({ ...identity, seq, createdAt });
        }
        seq += 1;
      }
      pruneTranscriptReactionsInTransaction(database, resolved);
      if (deleted || seq > 0) {
        if (rebuildSynchronously) {
          reconcileSessionTranscriptIndexInTransaction(database.db, resolved.sessionId);
        } else {
          withoutSqliteDatabaseWriteScope(database.db, () =>
            options.onProjectionReconcileNeeded?.(),
          );
          scheduleTranscriptProjectionReconcile(database, resolved.sessionId, true, options);
        }
        recordTranscriptReplacementMutation(
          database,
          resolved.sessionId,
          preservedTranscriptUpdatedAt,
        );
      }
    },
  );
}

function recordTranscriptReplacementMutation(
  database: OpenClawAgentDatabase,
  sessionId: string,
  preservedUpdatedAt: number | null | undefined,
): void {
  if (preservedUpdatedAt === undefined || preservedUpdatedAt === null) {
    touchTranscriptMutationInTransaction(database, sessionId);
    return;
  }
  // Maintenance rewrites must invalidate in-flight projections without making an old session
  // look newly active. A one-tick advance preserves ordering while changing the snapshot key.
  advanceTranscriptMutationAtInTransaction(database, sessionId, preservedUpdatedAt, {
    strictly: true,
  });
}

/** Rewrite existing transcript rows exactly, without append-time deduplication. */
export function rewriteSqliteTranscriptEventRowsInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  rows: readonly {
    event: TranscriptEvent;
    expectedEventJson: string;
    seq: number;
  }[],
  options: { legacyTextStorage?: boolean } = {},
): void {
  if (rows.length === 0) {
    return;
  }
  const rewrites = rows.map((row) => {
    const eventJson = JSON.stringify(canonicalizeTranscriptEventMedia(row.event));
    return {
      ...row,
      eventJson,
      payload: options.legacyTextStorage
        ? undefined
        : prepareTranscriptPayload(database.db, eventJson),
    };
  });
  const projectionUnchanged =
    !sessionTranscriptIndexNeedsReconcile(database.db, resolved.sessionId) &&
    rewrites.every((row) =>
      transcriptRewritePreservesProjection(row.expectedEventJson, row.eventJson),
    );
  const rebuildSynchronously =
    !options.legacyTextStorage &&
    !projectionUnchanged &&
    shouldRebuildSessionTranscriptIndexSynchronously(database.db, resolved.sessionId);
  return withSqliteDatabaseWriteScope(
    database.db,
    [resolved.sessionKey, sqliteSessionIdWriteScope(resolved.sessionId)],
    () => {
      const db = getSessionKysely(database.db);
      const rewrite = prepareSqliteQuerySync<(typeof rewrites)[number]>(database.db, (parameter) =>
        db
          .updateTable("transcript_events")
          .set(
            options.legacyTextStorage
              ? { event_json: parameter((row) => row.eventJson) }
              : {
                  event_json: parameter((row) => row.payload!.event_json),
                  event_zstd: parameter((row) => row.payload!.event_zstd),
                  event_utf8_bytes: parameter((row) => row.payload!.event_utf8_bytes),
                  navigation_json: parameter((row) => row.payload!.navigation_json),
                  navigation_type: parameter((row) => row.payload!.navigation_type),
                  navigation_custom_type: parameter((row) => row.payload!.navigation_custom_type),
                  navigation_display: parameter((row) => row.payload!.navigation_display),
                  message_role: parameter((row) => row.payload!.message_role),
                  navigation_last_type: parameter((row) => row.payload!.navigation_last_type),
                  navigation_last_custom_type: parameter(
                    (row) => row.payload!.navigation_last_custom_type,
                  ),
                  navigation_valid: parameter((row) => row.payload!.navigation_valid),
                },
          )
          .where("session_id", "=", resolved.sessionId)
          .where(
            "seq",
            "=",
            parameter((row) => row.seq),
          )
          .where(
            options.legacyTextStorage ? "event_json" : transcriptEventJsonSql(database.db),
            "=",
            parameter((row) => row.expectedEventJson),
          ),
      );
      for (const row of rewrites) {
        const result = rewrite(row);
        if (result.numAffectedRows !== 1n) {
          throw new Error(
            `Transcript row ${resolved.sessionId}:${row.seq} changed before exact rewrite`,
          );
        }
      }
      // Steering correlation changes no admitted input. Keep its running turn's fence,
      // while every other payload rewrite still invalidates admissions and cursors.
      if (
        !rewrites.every((row) => isSteerConfirmationRewrite(row.expectedEventJson, row.eventJson))
      ) {
        rotateTranscriptGenerationInTransaction(database, resolved.sessionId);
      }
      if (!projectionUnchanged) {
        if (options.legacyTextStorage) {
          // Media Doctor rebuilds after the physical storage migration; schema-22 readers
          // cannot inspect an older TEXT-only transcript table during this repair.
          markSessionTranscriptIndexDirtyInTransaction(database.db, resolved.sessionId);
        } else {
          reconcileRewrittenTranscriptIndex(database, resolved.sessionId, rebuildSynchronously);
        }
      }
      touchTranscriptMutationInTransaction(database, resolved.sessionId);
    },
  );
}

function reconcileRewrittenTranscriptIndex(
  database: OpenClawAgentDatabase,
  sessionId: string,
  rebuildSynchronously: boolean,
): void {
  // Dirty state revokes prepared claims and hides old rows; reconcile alone owns their deletion.
  markSessionTranscriptIndexDirtyInTransaction(database.db, sessionId);
  if (rebuildSynchronously) {
    reconcileSessionTranscriptIndexInTransaction(database.db, sessionId);
  } else {
    scheduleTranscriptProjectionReconcile(database, sessionId, true, {});
  }
}

// Preserves seq, created_at, session_key, and session activity recency; rotates the transcript
// generation and rebuilds bounded projections immediately or defers large projections.
export function updateSqliteTranscriptEventJsonInTransaction(
  database: OpenClawAgentDatabase,
  sessionId: string,
  updates: ReadonlyArray<{ seq: number; eventJson: string }>,
): void {
  if (updates.length === 0) {
    return;
  }
  return withSqliteDatabaseWriteScope(database.db, [sqliteSessionIdWriteScope(sessionId)], () => {
    const rebuildSynchronously = shouldRebuildSessionTranscriptIndexSynchronously(
      database.db,
      sessionId,
    );
    const update = createTranscriptPayloadUpdater(database.db, sessionId);
    for (const row of updates) {
      update({ seq: row.seq, ...prepareTranscriptPayload(database.db, row.eventJson) });
    }
    rotateTranscriptGenerationInTransaction(database, sessionId);
    reconcileRewrittenTranscriptIndex(database, sessionId, rebuildSynchronously);
    recordTranscriptReplacementMutation(
      database,
      sessionId,
      readTranscriptMutationStateInTransaction(database, sessionId).updatedAt,
    );
  });
}

export function readTranscriptMessageByScopedIdempotencyKey(
  database: Pick<OpenClawAgentDatabase, "db">,
  scope: ResolvedTranscriptScope,
  idempotencyKey: string,
  lookup: TranscriptMessageAppendOptions<unknown>["idempotencyLookup"],
): { messageId: string; message: unknown } | undefined {
  if (lookup !== "scan-assistant") {
    const identity = readIdempotencyKeyOwner(database, scope.sessionId, idempotencyKey);
    return identity ? readTranscriptMessageByIdentity(database, scope, identity) : undefined;
  }
  const found = findAssistantTranscriptEventInDatabase(database, scope.sessionId, idempotencyKey);
  if (!found) {
    return undefined;
  }
  const message = readTranscriptEventMessage(found.event);
  return message
    ? { messageId: readTranscriptEventId(found.event) ?? idempotencyKey, message }
    : undefined;
}

export function readSessionTranscriptMessageByEventId(
  scope: SessionTranscriptRuntimeScope,
  eventId: string,
): { messageId: string; message: unknown } | undefined {
  const resolved = resolveSqliteTranscriptScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return readHotSessionTranscriptSnapshot(database, resolved.sessionId, "identity", () =>
    readTranscriptMessageByEventId(database, resolved, eventId),
  );
}

export function readTranscriptMessageByEventId(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  eventId: string,
): { messageId: string; message: unknown } | undefined {
  const identity = readTranscriptIdentityByEventId(database, scope.sessionId, eventId);
  return identity ? readTranscriptMessageByIdentity(database, scope, identity) : undefined;
}

export function sanitizeTranscriptMessageForStorage<TMessage>(message: TMessage): TMessage {
  return isTranscriptAgentMessage(message)
    ? (sanitizeTranscriptMessage(message) as TMessage)
    : message;
}

function isTranscriptAgentMessage(value: unknown): value is AgentMessage {
  return isRecord(value) && typeof value.role === "string";
}
