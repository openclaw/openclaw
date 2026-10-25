import {
  sqliteSessionIdWriteScope,
  withSqliteDatabaseWriteScope,
  withoutSqliteDatabaseWriteScope,
} from "../../infra/sqlite-database-admission.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { preserveSessionEntryCacheAcrossWrite } from "./session-accessor.sqlite-entry-cache.js";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import type {
  TranscriptAppendCursor,
  TranscriptAppendOptions,
  TranscriptInsertRow,
} from "./session-accessor.sqlite-transcript-append.types.js";
import {
  readTranscriptAppendIdentities,
  createTranscriptIdentityInserter,
  readIdempotencyKeyOwner,
  readTranscriptEventIdentity,
} from "./session-accessor.sqlite-transcript-identity.js";
import {
  touchTranscriptMutationInTransaction,
  touchTranscriptWindowRecency,
} from "./session-accessor.sqlite-transcript-state.js";
import type { TranscriptMutationAdvance } from "./session-transcript-mutation-projection.js";
import { scheduleTranscriptProjectionReconcile } from "./session-transcript-reconcile.js";
import { copyRetainedTranscriptPayload } from "./session-transcript-retained-data.js";
import { canonicalizeTranscriptEventMedia } from "./transcript-event-media.js";
import {
  createTranscriptEventInserter,
  TRANSCRIPT_INSERT_BATCH_SIZE,
} from "./transcript-payload.js";

export function createTranscriptAppendBatch(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  events: Iterable<TranscriptEvent, unknown, boolean>,
  options: Omit<TranscriptAppendOptions, "onProjectionReconcileNeeded">,
) {
  // Prepared arrays and the import spool cannot mutate the destination between
  // rows. Sequence and projection facts belong only to this synchronous batch.
  const batch: NonNullable<TranscriptAppendCursor["batch"]> = {
    events: [],
    identities: new Map(),
    knownEventIds: new Set(),
    keyOwners: new Map(),
    preparedArray: Array.isArray(events),
    bytes: 0,
  };
  if (Array.isArray(events) && events.length > 0) {
    const identities = events.flatMap((event) => {
      const identity = readTranscriptEventIdentity(event);
      return identity ? [identity] : [];
    });
    if (identities.length > 0) {
      for (const row of readTranscriptAppendIdentities(
        database,
        scope.sessionId,
        identities.map((identity) => identity.eventId),
        identities.flatMap((identity) =>
          identity.messageIdempotencyKey ? [identity.messageIdempotencyKey] : [],
        ),
      )) {
        batch.knownEventIds.add(row.event_id);
        if (row.message_idempotency_key) {
          batch.keyOwners.set(row.message_idempotency_key, { eventId: row.event_id, seq: row.seq });
        }
      }
    }
  }
  const cursor: TranscriptAppendCursor = { deferWrites: true, batch };
  const flushRows = () =>
    withSqliteDatabaseWriteScope(
      database.db,
      [scope.sessionKey, sqliteSessionIdWriteScope(scope.sessionId)],
      () =>
        preserveSessionEntryCacheAcrossWrite(database, () => {
          // PG uses the payload CTE's accepted sequences; SQLite keeps its two writes.
          const identities = [...batch.identities.values()];
          if (cursor.insertEvent?.batchWithIdentities) {
            cursor.insertEvent.batchWithIdentities(batch.events, identities);
          } else {
            cursor.insertEvent?.batch(batch.events);
            cursor.insertIdentity?.batch(identities);
          }
          cursor.appendToIndex?.flushRows();
          batch.events.length = 0;
          batch.identities.clear();
          batch.bytes = 0;
          if (!batch.preparedArray) {
            batch.knownEventIds.clear();
            batch.keyOwners.clear();
          }
        }),
    );
  return {
    cursor,
    flushFullChunk() {
      if (batch.events.length >= TRANSCRIPT_INSERT_BATCH_SIZE || batch.bytes >= 1024 * 1024) {
        flushRows();
      }
    },
    settle(
      completed: boolean,
      appended: number,
      projectionNeedsRebuild: boolean,
      logicalAdvance?: TranscriptMutationAdvance,
    ) {
      // A caller may catch an iterator error and commit the accepted prefix.
      // Settle its index and attempt recency without advancing the mutation fence.
      preserveSessionEntryCacheAcrossWrite(database, () => {
        flushRows();
        cursor.appendToIndex?.flush();
        if (completed && appended > 0 && options.touchMutation !== false) {
          touchTranscriptMutationInTransaction(
            database,
            scope.sessionId,
            cursor.windowUpdatedAt,
            projectionNeedsRebuild ? undefined : cursor.rowTranscript,
            undefined,
            undefined,
            logicalAdvance,
          );
        } else if (cursor.windowUpdatedAt !== undefined) {
          touchTranscriptWindowRecency(database, scope.sessionId, cursor.windowUpdatedAt, cursor);
        }
      });
      if (completed && appended > 0) {
        scheduleTranscriptProjectionReconcile(
          database,
          scope.sessionId,
          projectionNeedsRebuild,
          options,
        );
      }
    },
  };
}

/** Inserts exact transcript rows without mutating the forward-only projection. */
export function insertTranscriptRowsWithoutProjectionInTransaction(
  database: OpenClawAgentDatabase,
  sessionId: string,
  rows: readonly TranscriptInsertRow[],
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
