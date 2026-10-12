import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { readSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { chunkItems } from "../../utils/chunk-items.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import {
  loadTranscriptEventsFromDatabase,
  readTranscriptEventMessage,
} from "./session-accessor.sqlite-read.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { createTranscriptEntryAnchor } from "./session-accessor.sqlite-transcript-anchor.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";
import { sessionTranscriptIndexNeedsReconcile } from "./session-transcript-index.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import { readMessageIdempotencyKey } from "./transcript-message-identity.js";
import { transcriptEventJsonSql, transcriptEventRunIdSql } from "./transcript-payload.js";
import { selectVisibleTranscriptEvents } from "./transcript-visible-events.js";

// Keep supplied-key probes below SQLite's conservative variable ceiling.
const TRANSCRIPT_MIRROR_KEY_QUERY_BATCH_SIZE = 900;

type TranscriptMirrorFacts = {
  anchorsByIdempotencyKey: Map<string, TranscriptEntryAnchor>;
  existingIdempotencyKeys: Set<string>;
  messagesByIdempotencyKey: Map<string, unknown>;
  sourceEvents?: TranscriptEvent[];
};

/** Returns raw events only when the transcript identity projection is not current. */
function loadTranscriptEventsForMirrorFallback(
  database: OpenClawAgentDatabase,
  sessionId: string,
): TranscriptEvent[] | undefined {
  const db = getSessionKysely(database.db);
  const latest = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select("seq")
      .where("session_id", "=", sessionId)
      .orderBy("seq", "desc")
      .limit(1),
  );
  if (!latest) {
    return [];
  }
  const state = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_transcript_index_state")
      .select(["indexed_seq", "needs_rebuild"])
      .where("session_id", "=", sessionId),
  );
  if (state && state.needs_rebuild === 0 && state.indexed_seq === latest.seq) {
    return undefined;
  }
  // Raw rows stay authoritative if projection maintenance has not caught up.
  return loadTranscriptEventsFromDatabase(database, sessionId);
}

/** Reads the bounded identity facts needed by transcript mirrors. */
export function readTranscriptMirrorFacts(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  params: {
    idempotencyKeys: readonly string[];
    sourceRunId?: string;
  },
): TranscriptMirrorFacts {
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      assertSessionTranscriptHot(database.db, resolved.sessionId);
      const idempotencyKeys = [...new Set(params.idempotencyKeys)];
      const fallbackEvents = loadTranscriptEventsForMirrorFallback(database, resolved.sessionId);
      if (fallbackEvents !== undefined) {
        return readMirrorFactsFromEvents(
          fallbackEvents,
          new Set(idempotencyKeys),
          params.sourceRunId,
        );
      }

      const db = getSessionKysely(database.db);
      const facts: TranscriptMirrorFacts = {
        anchorsByIdempotencyKey: new Map(),
        existingIdempotencyKeys: new Set(),
        messagesByIdempotencyKey: new Map(),
      };
      const batches = chunkItems(idempotencyKeys, TRANSCRIPT_MIRROR_KEY_QUERY_BATCH_SIZE);
      if (params.sourceRunId) {
        facts.sourceEvents = [];
        if (batches.length === 0) {
          batches.push([]);
        }
      }
      let anchorsReady: boolean | undefined;
      for (const batch of batches) {
        const sourceRunId = batch === batches[0] ? params.sourceRunId : undefined;
        const rows = executeSqliteQuerySync(
          database.db,
          db
            .selectFrom("transcript_events as event")
            .leftJoin("transcript_event_identities as identity", (join) =>
              join
                .onRef("identity.session_id", "=", "event.session_id")
                .onRef("identity.seq", "=", "event.seq"),
            )
            .leftJoin("session_transcript_active_events as active", (join) =>
              join
                .onRef("active.session_id", "=", "event.session_id")
                .onRef("active.event_seq", "=", "event.seq"),
            )
            .leftJoin("transcript_rewrite_watermarks as rewrite", (join) =>
              join.onRef("rewrite.session_id", "=", "event.session_id"),
            )
            .select([
              "identity.event_id",
              "identity.message_idempotency_key",
              "event.seq",
              "identity.parent_id",
              transcriptEventJsonSql(database.db, "event").as("event_json"),
              "active.message_position",
              "rewrite.generation",
            ])
            .where("event.session_id", "=", resolved.sessionId)
            .where((eb) => {
              const matchesKey = eb("identity.message_idempotency_key", "in", batch);
              return sourceRunId
                ? eb.or([
                    matchesKey,
                    eb.and([
                      eb("active.event_seq", "is not", null),
                      eb(transcriptEventRunIdSql("event"), "=", sourceRunId),
                    ]),
                  ])
                : matchesKey;
            })
            .orderBy("event.seq", "asc"),
        ).rows;
        for (const row of rows) {
          // SAFETY: event_json reconstructs the stored TranscriptEvent via transcriptEventJsonSql.
          const event = JSON.parse(row.event_json) as TranscriptEvent;
          const message = readTranscriptEventMessage(event);
          if (
            sourceRunId &&
            row.message_position !== null &&
            readSessionTranscriptRunId(message) === sourceRunId
          ) {
            facts.sourceEvents?.push(event);
          }
          const idempotencyKey = row.message_idempotency_key;
          if (!idempotencyKey || !row.event_id || !batch.includes(idempotencyKey)) {
            continue;
          }
          facts.existingIdempotencyKeys.add(idempotencyKey);
          anchorsReady ??= !sessionTranscriptIndexNeedsReconcile(database.db, resolved.sessionId);
          const anchor = anchorsReady
            ? createTranscriptEntryAnchor({
                database,
                resolved,
                entryId: row.event_id,
                row,
              })
            : undefined;
          if (anchor) {
            facts.anchorsByIdempotencyKey.set(idempotencyKey, anchor);
          }
          if (message !== undefined) {
            facts.messagesByIdempotencyKey.set(idempotencyKey, message);
          }
        }
      }
      return facts;
    },
    {
      databaseLabel: database.path,
      operationLabel: "session.transcript.mirror-facts",
    },
  );
}

/** Extracts supplied mirror identities from authoritative transcript events. */
function readMirrorFactsFromEvents(
  events: readonly TranscriptEvent[],
  candidateKeys: ReadonlySet<string>,
  sourceRunId?: string,
): TranscriptMirrorFacts {
  const facts: TranscriptMirrorFacts = {
    anchorsByIdempotencyKey: new Map(),
    existingIdempotencyKeys: new Set(),
    messagesByIdempotencyKey: new Map(),
  };
  if (sourceRunId) {
    facts.sourceEvents = selectVisibleTranscriptEvents(events).filter(
      (event) => readSessionTranscriptRunId(readTranscriptEventMessage(event)) === sourceRunId,
    );
  }
  for (const event of events) {
    const message = readTranscriptEventMessage(event);
    const idempotencyKey = readMessageIdempotencyKey(message);
    if (!idempotencyKey || !candidateKeys.has(idempotencyKey)) {
      continue;
    }
    facts.existingIdempotencyKeys.add(idempotencyKey);
    if (message !== undefined) {
      facts.messagesByIdempotencyKey.set(idempotencyKey, message);
    }
  }
  return facts;
}
