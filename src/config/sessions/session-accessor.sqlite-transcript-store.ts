import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parseCompactionDetails } from "../../../packages/agent-core/src/harness/compaction/compaction-details.js";
import type { AgentMessage } from "../../agents/runtime/index.js";
import { sanitizeTranscriptMessage } from "../../agents/transcript-sanitize.js";
import {
  projectSessionRowTranscriptFields,
  readStoredSessionRowTranscriptProjection,
} from "../../gateway/session-row-transcript-preview.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  sqliteSessionIdWriteScope,
  withoutSqliteDatabaseWriteScope,
  withSqliteDatabaseWriteScope,
} from "../../infra/sqlite-database-admission.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { advanceCliHistoryBoundaryInTransaction } from "./session-accessor.sqlite-cli-history-boundary.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { preserveSessionEntryCacheAcrossWrite } from "./session-accessor.sqlite-entry-cache.js";
import { readSessionEntryRow, writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { preparePriorWorkspaceRewriteInTransaction } from "./session-accessor.sqlite-prior-workspace.js";
import {
  createTranscriptIdentityReader,
  readEventTimestamp,
} from "./session-accessor.sqlite-read.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import type {
  TranscriptAppendCursor,
  TranscriptAppendOptions,
} from "./session-accessor.sqlite-transcript-append.types.js";
import { createTranscriptAppendBatch } from "./session-accessor.sqlite-transcript-batch.js";
import {
  createTranscriptIdentityInserter,
  readIdempotencyKeyOwner,
  readTranscriptEventIdentity,
} from "./session-accessor.sqlite-transcript-identity.js";
import type { TranscriptReplacementOptions } from "./session-accessor.sqlite-transcript-rewrite.types.js";
import {
  deleteTranscriptEventsInTransaction,
  ensureTranscriptGenerationInTransaction,
  ensureTranscriptSessionRoot,
  pruneTranscriptReactionsInTransaction,
  readTranscriptGenerationInTransaction,
  readTranscriptMutationStateInTransaction,
  readNextTranscriptSeq,
  readTranscriptAppendStateInTransaction,
  rotateTranscriptGenerationInTransaction,
  touchTranscriptMutationInTransaction,
  touchTranscriptWindowRecency,
  recordTranscriptReplacementMutation,
} from "./session-accessor.sqlite-transcript-state.js";
import { appendSessionActorContextStats } from "./session-actor-context-metadata.js";
import {
  readSessionActorTransactionState,
  writableSessionActorMap,
  writableSessionActorNavigation,
} from "./session-actor-transaction.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";
import type { PriorWorkspaceRewriteRows } from "./session-prior-workspace-boundary.js";
import {
  createTranscriptIndexAppenderInTransaction,
  deleteSessionTranscriptIndexInTransaction,
  markSessionTranscriptIndexDirtyInTransaction,
  reconcileSessionTranscriptIndexInTransaction,
  shouldRebuildSessionTranscriptIndexSynchronously,
} from "./session-transcript-index.js";
import { hasTranscriptMessage } from "./session-transcript-projection-append.js";
import { scheduleTranscriptProjectionReconcile } from "./session-transcript-reconcile.js";
import { canonicalizeTranscriptEventMedia } from "./transcript-event-media.js";
import { projectTranscriptNavigationFields } from "./transcript-navigation-fields.js";
import {
  createTranscriptEventInserter,
  prepareTranscriptPayloadForReuse,
  transcriptSerializedBytes,
} from "./transcript-payload.js";

export {
  rewriteSqliteTranscriptEventRowsInTransaction,
  updateSqliteTranscriptEventJsonInTransaction,
} from "./session-accessor.sqlite-transcript-rewrite.js";

/** Returns the exact committed JSON, or false when an existing identity owns the event. */
export function appendTranscriptEventInTransaction(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  event: TranscriptEvent,
  options: TranscriptAppendOptions = {},
  cursor: TranscriptAppendCursor = {},
): string | false {
  const priorAssistant = !cursor.initialized
    ? "unchanged"
    : cursor.rowTranscript
      ? cursor.rowTranscript.lastAssistantMessage
      : "unknown";
  const persistedEvent =
    options.eventJson === undefined ? canonicalizeTranscriptEventMedia(event) : event;
  return withSqliteDatabaseWriteScope(
    database.db,
    [scope.sessionKey, sqliteSessionIdWriteScope(scope.sessionId)],
    () => {
      const db = getSessionKysely(database.db);
      const actor = readSessionActorTransactionState(database, scope);
      const initial =
        !cursor.initialized && !actor
          ? readTranscriptAppendStateInTransaction(database, scope)
          : undefined;
      const window = initial?.roots[0];
      const isCompaction = isRecord(persistedEvent) && persistedEvent.type === "compaction";
      const previousCompactionDisplay = isCompaction
        ? (cursor.rowTranscript ??
          readStoredSessionRowTranscriptProjection({
            json: window?.row_transcript_json,
            updatedAt: window?.row_transcript_updated_at,
            transcriptUpdatedAt: window?.transcript_updated_at,
            indexedSeq: initial?.projection?.indexedSeq,
          }))
        : undefined;
      const createdAt = readEventTimestamp(persistedEvent) ?? Date.now();
      let windowUpdatedAt = createdAt;
      const windowExists = Boolean(
        cursor.initialized || actor?.window || window?.persisted_session_key,
      );
      // The existing window can share the final watermark write. Rejected identities
      // still need their recency-only write, without advancing the transcript fence.
      const deferWindowTouch =
        cursor.deferWrites || (options.touchMutation !== false && windowExists);
      const touchWindow = (shouldTouch: boolean) => {
        if (shouldTouch && !cursor.deferWrites) {
          touchTranscriptWindowRecency(database, scope.sessionId, createdAt, cursor);
        }
      };
      if (cursor.initialized) {
        // The first attempt established this window and the batch cannot delete it.
        touchWindow(!deferWindowTouch);
      } else {
        ensureTranscriptSessionRoot(database, scope, createdAt, {
          allowStoredAlias: options.allowStoredAlias === true,
          onPlaceholderInserted: options.onPlaceholderInserted,
          deferExistingWindowTouch: deferWindowTouch,
          preparedRoots: initial?.roots,
        });
        if (!initial?.generation) {
          preserveSessionEntryCacheAcrossWrite(database, () =>
            ensureTranscriptGenerationInTransaction(database, scope.sessionId),
          );
        }
        if (initial) {
          if (initial.cold) {
            throw new SessionTranscriptColdError(scope.sessionId);
          }
          cursor.nextSeq = initial.nextSeq;
          cursor.appendToIndex = createTranscriptIndexAppenderInTransaction(
            database.db,
            scope.sessionId,
            { state: initial.projection },
          );
        }
        cursor.initialized = true;
      }
      if (windowExists) {
        cursor.windowUpdatedAt = createdAt;
      }
      // Sequence admission also refuses cold archives, once for the entire batch.
      const seq = (cursor.nextSeq ??= readNextTranscriptSeq(database, scope.sessionId));
      const identity = readTranscriptEventIdentity(persistedEvent);
      const batch = cursor.batch;
      if (identity && (batch || actor?.transcript.complete)) {
        const exists =
          actor?.transcript.identities.has(identity.eventId) ||
          batch?.knownEventIds.has(identity.eventId) ||
          (batch &&
            !batch.preparedArray &&
            (cursor.readIdentity ??= createTranscriptIdentityReader(database, scope.sessionId))(
              identity.eventId,
            ));
        if (exists) {
          touchWindow(deferWindowTouch);
          return false;
        }
      }
      const key = identity?.messageIdempotencyKey;
      const idempotencyKeyOwner = key
        ? batch && (batch.preparedArray || batch.keyOwners.has(key))
          ? batch.keyOwners.get(key)
          : readIdempotencyKeyOwner(database, scope.sessionId, key)
        : undefined;
      if (idempotencyKeyOwner && options.idempotencyKeyMode === "dedupe") {
        touchWindow(deferWindowTouch);
        return false;
      }
      cursor.insertEvent ??= createTranscriptEventInserter(database.db, scope.sessionId);
      const insertEvent = cursor.insertEvent;
      if (identity && idempotencyKeyOwner && options.idempotencyKeyMode !== "relocate-owner") {
        identity.messageIdempotencyKey = null;
      }
      // Relocation must accept the event before clearing the previous identity's key.
      const insertWithIdentity =
        !batch &&
        identity &&
        !(idempotencyKeyOwner && options.idempotencyKeyMode === "relocate-owner")
          ? insertEvent.withIdentity
          : undefined;
      const eventJson =
        options.eventJson ??
        withoutSqliteDatabaseWriteScope(database.db, () => JSON.stringify(persistedEvent));
      const serializedBytes = transcriptSerializedBytes(database.db, eventJson);
      let projectionNeedsRebuild = false;
      let accepted = true;
      preserveSessionEntryCacheAcrossWrite(database, () => {
        const row = {
          seq,
          eventJson,
          createdAt,
          parsedEvent: options.eventJson === undefined ? undefined : persistedEvent,
          preparedPayload: options.preparedPayload,
        };
        if (batch) {
          row.preparedPayload ??= prepareTranscriptPayloadForReuse(
            database.db,
            eventJson,
            persistedEvent,
          );
          batch.events.push(row);
          batch.bytes += serializedBytes;
        } else {
          const input = {
            ...row,
            eventId: actor?.transcript.complete ? undefined : identity?.eventId,
          };
          accepted =
            insertWithIdentity && identity
              ? insertWithIdentity(input, identity)
              : insertEvent(input);
          if (!accepted) {
            return;
          }
        }
        if (actor) {
          actor.hot.transcript.version.rawSeq = seq;
          actor.hot.transcript.watermark.maxSeq = seq;
          const stored: unknown = JSON.parse(eventJson);
          actor.transcript.payloads = writableSessionActorMap(actor.transcript.payloads);
          actor.transcript.payloads.set(seq, {
            event: stored,
            serializedBytes,
          });
          actor.transcript.navigation = writableSessionActorNavigation(actor.transcript.navigation);
          const navigation = isRecord(stored) ? projectTranscriptNavigationFields(stored) : {};
          actor.transcript.navigation.push(Object.assign(navigation, { seq }));
        }
        cursor.nextSeq = seq + 1;
        cursor.appendToIndex ??= createTranscriptIndexAppenderInTransaction(
          database.db,
          scope.sessionId,
        );
        projectionNeedsRebuild = cursor.appendToIndex.append({
          seq,
          event: persistedEvent,
          eventId: identity?.eventId ?? null,
          createdAt,
        });
        if (!cursor.deferWrites) {
          cursor.appendToIndex.flush();
        }
        if (actor) {
          appendSessionActorContextStats(
            actor,
            seq,
            persistedEvent,
            serializedBytes,
            projectionNeedsRebuild,
          );
        }
      });
      if (!accepted) {
        touchWindow(deferWindowTouch);
        return false;
      }
      if (projectionNeedsRebuild) {
        withoutSqliteDatabaseWriteScope(database.db, () => options.onProjectionReconcileNeeded?.());
      }
      if (identity) {
        preserveSessionEntryCacheAcrossWrite(database, () => {
          if (actor) {
            actor.transcript.identities = writableSessionActorMap(actor.transcript.identities);
          }
          // Replayed copies take ownership so later retries resolve on the active branch.
          // scan-assistant preserves a colliding user's ownership instead.
          if (idempotencyKeyOwner && options.idempotencyKeyMode === "relocate-owner") {
            const pending = batch?.identities.get(idempotencyKeyOwner.eventId);
            if (pending) {
              pending.messageIdempotencyKey = null;
            } else {
              executeSqliteQuerySync(
                database.db,
                db
                  .updateTable("transcript_event_identities")
                  .set({ message_idempotency_key: null })
                  .where("session_id", "=", scope.sessionId)
                  .where("event_id", "=", idempotencyKeyOwner.eventId),
              );
            }
            const previous = actor?.transcript.identities.get(idempotencyKeyOwner.eventId);
            if (previous) {
              actor?.transcript.identities.set(previous.event_id, {
                ...previous,
                message_idempotency_key: null,
              });
            }
          }
          cursor.insertIdentity ??= createTranscriptIdentityInserter(
            database,
            scope.sessionId,
            true,
          );
          const row = { ...identity, seq, createdAt };
          if (batch) {
            batch.identities.set(identity.eventId, row);
            batch.knownEventIds.add(identity.eventId);
            if (identity.messageIdempotencyKey) {
              batch.keyOwners.set(identity.messageIdempotencyKey, {
                eventId: identity.eventId,
                seq,
              });
            }
          } else if (!insertWithIdentity) {
            cursor.insertIdentity(row);
          }
          actor?.transcript.identities.set(identity.eventId, {
            session_id: scope.sessionId,
            event_id: identity.eventId,
            seq,
            event_type: identity.eventType,
            parent_id: identity.parentId,
            message_idempotency_key: identity.messageIdempotencyKey,
            created_at: createdAt,
          });
        });
      }
      advanceCliHistoryBoundaryInTransaction(database, scope, seq);
      if (isCompaction && parseCompactionDetails(persistedEvent.details)?.qualityDegraded) {
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
      cursor.rowTranscript = projectionNeedsRebuild
        ? undefined
        : (projectSessionRowTranscriptFields(
            persistedEvent,
            serializedBytes,
            seq,
            priorAssistant,
          ) ??
          // Forward compaction changes model context, not the visible message tail.
          (previousCompactionDisplay && { ...previousCompactionDisplay, indexedSeq: seq }));
      if (windowExists || windowUpdatedAt !== createdAt) {
        cursor.windowUpdatedAt = windowUpdatedAt;
      }
      if (options.touchMutation !== false) {
        preserveSessionEntryCacheAcrossWrite(database, () => {
          touchTranscriptMutationInTransaction(
            database,
            scope.sessionId,
            deferWindowTouch ? windowUpdatedAt : undefined,
            cursor.rowTranscript,
            options.persistActorMutation,
          );
        });
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

export function appendTranscriptEventsInTransaction(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  events: Iterable<TranscriptEvent, unknown, boolean>,
  options: Omit<TranscriptAppendOptions, "onProjectionReconcileNeeded"> = {},
): number {
  let appended = 0;
  let projectionNeedsRebuild = false;
  const batch = createTranscriptAppendBatch(database, scope, events, options);
  let completed = false;
  const iterator = events[Symbol.iterator]();
  const appendOptions = {
    ...options,
    onProjectionReconcileNeeded: () => (projectionNeedsRebuild = true),
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
        batch.cursor,
      );
      if (inserted) {
        appended += 1;
      }
      batch.flushFullChunk();
      // Streaming imports acknowledge only inserted rows in their byte-dedupe
      // spool; ordinary array iterators ignore this feedback.
      next = iterator.next(inserted !== false);
    }
    completed = true;
  } catch (error) {
    try {
      iterator.return?.();
    } catch {
      // Preserve the append error if iterator cleanup also fails.
    }
    throw error;
  } finally {
    batch.settle(completed, appended, projectionNeedsRebuild);
  }
  return appended;
}

export function replaceSqliteTranscriptEventsInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  events: readonly TranscriptEvent[],
  options: TranscriptReplacementOptions = {},
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
      const priorWorkspace = preparePriorWorkspaceRewriteInTransaction(database, resolved);
      const previousIdentities = priorWorkspace
        ? executeSqliteQuerySync(
            database.db,
            getSessionKysely(database.db)
              .selectFrom("transcript_event_identities")
              .select(["event_id", "seq"])
              .where("session_id", "=", resolved.sessionId),
          ).rows.map((row) => ({ id: row.event_id, seq: row.seq }))
        : [];
      const deleted = deleteTranscriptEventsInTransaction(database, resolved.sessionId);
      if (events.length === 0) {
        pruneTranscriptReactionsInTransaction(database, resolved);
        deleteSessionTranscriptIndexInTransaction(database.db, resolved.sessionId);
        if (deleted || previousGeneration) {
          const generation = rotateTranscriptGenerationInTransaction(database, resolved.sessionId);
          priorWorkspace?.commit(generation, {
            previous: previousIdentities,
            next: [],
            unchangedBeforeSeq: 0,
          });
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
      let generation = previousGeneration;
      if (deleted || previousGeneration) {
        generation = rotateTranscriptGenerationInTransaction(database, resolved.sessionId);
      } else {
        ensureTranscriptGenerationInTransaction(database, resolved.sessionId);
        if (priorWorkspace) {
          generation = readTranscriptGenerationInTransaction(database, resolved.sessionId);
        }
      }
      if (rebuildSynchronously) {
        deleteSessionTranscriptIndexInTransaction(database.db, resolved.sessionId);
      } else {
        // Preserve large old FTS rows; the dirty watermark hides them until worker reconciliation.
        markSessionTranscriptIndexDirtyInTransaction(database.db, resolved.sessionId);
      }
      let seq = 0;
      const nextIdentities: PriorWorkspaceRewriteRows["next"][number][] = [];
      const seenEventIds = new Set<string>();
      const seenMessageIdempotencyKeys = new Set<string>();
      const insertEvent = createTranscriptEventInserter(database.db, resolved.sessionId);
      const insertIdentity = createTranscriptIdentityInserter(database, resolved.sessionId, false);
      // The reset/dirty transition above owns the initial projection state for this whole batch.
      const appendToIndex = createTranscriptIndexAppenderInTransaction(
        database.db,
        resolved.sessionId,
      );
      try {
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
          const eventJson = withoutSqliteDatabaseWriteScope(database.db, () =>
            JSON.stringify(persistedEvent),
          );
          insertEvent({ seq, eventJson, createdAt });
          if (priorWorkspace) {
            nextIdentities.push({
              id: identity?.eventId ?? null,
              seq,
              message: hasTranscriptMessage(persistedEvent),
            });
          }
          options.writtenRows?.push({ seq, eventJson });
          appendToIndex.append({
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
      } finally {
        appendToIndex.flush();
      }
      pruneTranscriptReactionsInTransaction(database, resolved);
      priorWorkspace?.commit(generation ?? null, {
        previous: previousIdentities,
        next: nextIdentities,
        unchangedBeforeSeq: 0,
      });
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

export function sanitizeTranscriptMessageForStorage<TMessage>(message: TMessage): TMessage {
  return isTranscriptAgentMessage(message)
    ? (sanitizeTranscriptMessage(message) as TMessage)
    : message;
}

function isTranscriptAgentMessage(value: unknown): value is AgentMessage {
  return isRecord(value) && typeof value.role === "string";
}
