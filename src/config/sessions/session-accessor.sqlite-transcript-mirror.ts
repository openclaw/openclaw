import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
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
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import { readMessageIdempotencyKey } from "./transcript-message-identity.js";
import {
  transcriptEventJsonSql,
  transcriptEventRunIdSql,
  transcriptPredicateSql,
} from "./transcript-payload.js";
import { selectVisibleTranscriptEvents } from "./transcript-visible-events.js";

// Keep supplied-key probes below SQLite's conservative variable ceiling.
const TRANSCRIPT_MIRROR_KEY_QUERY_BATCH_SIZE = 900;
// Legacy runs without an indexed input can only be correlated while still recent.
const TRANSCRIPT_MIRROR_RUN_LOOKBACK_EVENTS = 4096;

type TranscriptMirrorFacts = {
  anchorsByIdempotencyKey: Map<string, TranscriptEntryAnchor>;
  existingIdempotencyKeys: Set<string>;
  messagesByIdempotencyKey: Map<string, unknown>;
  sourceEvents?: TranscriptEvent[];
};

/** Read projection readiness once in the mirror's transaction snapshot. */
function readTranscriptMirrorProjection(database: OpenClawAgentDatabase, sessionId: string) {
  const db = getSessionKysely(database.db);
  const state = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom(
        db
          .selectFrom("transcript_events")
          .select("seq")
          .where("session_id", "=", sessionId)
          .orderBy("seq", "desc")
          .limit(1)
          .as("latest"),
      )
      .leftJoin("session_transcript_index_state as state", (join) =>
        join.on("state.session_id", "=", sessionId),
      )
      .select(["latest.seq", "state.indexed_seq", "state.needs_rebuild"])
      .select((eb) =>
        eb
          .exists(
            eb
              .selectFrom("session_transcript_active_events")
              .select("session_id")
              .where("session_id", "=", sessionId)
              .where("context_eligible", "is", null),
          )
          .as("has_unclassified"),
      ),
  );
  if (!state) {
    return { fallbackEvents: [], anchorsReady: false };
  }
  if (state.needs_rebuild === 0 && state.indexed_seq === state.seq) {
    return { fallbackEvents: undefined, anchorsReady: !state.has_unclassified };
  }
  // Raw rows stay authoritative if projection maintenance has not caught up.
  return {
    fallbackEvents: loadTranscriptEventsFromDatabase(database, sessionId),
    anchorsReady: false,
  };
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
      const { fallbackEvents, anchorsReady } = readTranscriptMirrorProjection(
        database,
        resolved.sessionId,
      );
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
      const events = db
        .selectFrom("transcript_event_identities as identity")
        .innerJoin("transcript_events as event", (join) =>
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
        ]);
      for (const batch of batches) {
        let query = events
          .where("identity.session_id", "=", resolved.sessionId)
          .where("identity.message_idempotency_key", "in", batch)
          .select((eb) => eb.val(0).as("is_source"));
        const sourceRunId = batch === batches[0] ? params.sourceRunId : undefined;
        if (sourceRunId) {
          // UNION keeps each branch independently indexable; an OR here scans
          // the session. The input bounds long runs without truncating them.
          query = query.unionAll(
            events
              .where("event.session_id", "=", resolved.sessionId)
              .where("active.event_seq", "is not", null)
              .where(transcriptPredicateSql(database.db, "message_role", "event"), "=", "assistant")
              .where("event.seq", ">=", (eb) =>
                eb.fn.coalesce(
                  db
                    .selectFrom("transcript_event_identities")
                    .select("seq")
                    .where("session_id", "=", resolved.sessionId)
                    .where("message_idempotency_key", "=", `${sourceRunId}:user`),
                  eb(
                    db
                      .selectFrom("transcript_events")
                      .select((latest) => latest.fn.max<number>("seq").as("seq"))
                      .where("session_id", "=", resolved.sessionId),
                    "-",
                    TRANSCRIPT_MIRROR_RUN_LOOKBACK_EVENTS - 1,
                  ),
                ),
              )
              .where(transcriptEventRunIdSql(database.db, "event"), "=", sourceRunId)
              .select((eb) => eb.val(1).as("is_source")),
          );
        }
        const rows = executeSqliteQuerySync(
          database.db,
          query.orderBy(isPostgresSqlConnection(database.db) ? "seq" : "event.seq", "asc"),
        ).rows;
        for (const row of rows) {
          // SAFETY: event_json reconstructs the stored TranscriptEvent via transcriptEventJsonSql.
          const event = JSON.parse(row.event_json) as TranscriptEvent;
          if (row.is_source) {
            facts.sourceEvents?.push(event);
            continue;
          }
          const message = readTranscriptEventMessage(event);
          const idempotencyKey = row.message_idempotency_key;
          if (!idempotencyKey || !row.event_id || !batch.includes(idempotencyKey)) {
            continue;
          }
          facts.existingIdempotencyKeys.add(idempotencyKey);
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
    facts.sourceEvents = selectVisibleTranscriptEvents(events).filter((event) => {
      const message = readTranscriptEventMessage(event);
      return message?.role === "assistant" && readSessionTranscriptRunId(message) === sourceRunId;
    });
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
