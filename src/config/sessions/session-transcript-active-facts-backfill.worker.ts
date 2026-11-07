import { sql } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { isPostgresSqlConnection, type EngineConnection } from "../../infra/sql-connection.js";
import { runWithSqliteBusyTimeout } from "../../infra/sqlite-busy-timeout.js";
import {
  sqliteSessionIdWriteScope,
  withSqliteDatabaseWriteScope,
} from "../../infra/sqlite-database-admission.js";
import { isSqliteLockError } from "../../infra/sqlite-error-diagnostics.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { bindSqliteWorkerDatabase } from "../../infra/sqlite-worker-binding.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type { SqliteWorkerDatabaseContext } from "../../infra/sqlite-worker-database-context.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import { transcriptDependencyFactsProjectableSql } from "./session-transcript-active-facts.js";
import { sessionTranscriptIndexNeedsReconcile } from "./session-transcript-index.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";
import {
  transcriptEventDependencyNavigationSql,
  transcriptPredicateSql,
} from "./transcript-payload.js";

export type TranscriptActiveFactsBackfillSession = {
  sessionId: string;
  activeEventCount: number;
  updatedAt: number;
};
export type TranscriptActiveFactsBackfillCursor = { sessionId: string; afterPosition: number };
export type TranscriptActiveFactsBackfillBatch = {
  afterPosition: number;
  done: boolean;
  unavailable: boolean;
  busy: boolean;
  rowsFilled: number;
  rowsSkipped: number;
  rowsVisited: number;
  bytesRead: number;
  elapsedMs: number;
};

const MAX_IDENTITY_ROWS = 512;
const MAX_PAYLOAD_ROWS = 16;
const MAX_PAYLOAD_BYTES = 128 * 1024;
const MAX_BATCH_MS = 10;

/** Prioritize recent long paths using only small index-state rows, without counting coverage. */
export function discoverTranscriptActiveFactsBackfillSessions(
  database: EngineConnection,
): TranscriptActiveFactsBackfillSession[] {
  return executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<DB>(database)
      .selectFrom("session_transcript_index_state as state")
      .select([
        "state.session_id as sessionId",
        "state.active_event_count as activeEventCount",
        "state.updated_at as updatedAt",
      ])
      .where("state.needs_rebuild", "=", 0)
      .where("state.active_event_count", ">", 0)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("session_transcript_cold_archives as cold")
              .select("cold.session_id")
              .whereRef("cold.session_id", "=", "state.session_id"),
          ),
        ),
      )
      .orderBy(
        (eb) =>
          eb
            .case()
            .when("state.updated_at", ">=", Date.now() - 7 * 86_400_000)
            .then(1)
            .else(0)
            .end(),
        "desc",
      )
      .orderBy("state.active_event_count", "desc")
      .orderBy("state.updated_at", "desc")
      .orderBy("state.session_id"),
  ).rows;
}

/** Source reads and publication share the worker's nonblocking immediate transaction. */
export function backfillTranscriptActiveFactsBatchInTransaction(
  database: EngineConnection,
  cursor: TranscriptActiveFactsBackfillCursor,
): TranscriptActiveFactsBackfillBatch {
  const started = performance.now();
  const result: TranscriptActiveFactsBackfillBatch = {
    afterPosition: cursor.afterPosition,
    done: false,
    unavailable: false,
    busy: false,
    rowsFilled: 0,
    rowsSkipped: 0,
    rowsVisited: 0,
    bytesRead: 0,
    elapsedMs: 0,
  };
  const db = getNodeSqliteKysely<DB>(database);
  const cold = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("session_transcript_cold_archives")
      .select("session_id")
      .where("session_id", "=", cursor.sessionId),
  );
  if (cold || sessionTranscriptIndexNeedsReconcile(database, cursor.sessionId)) {
    return { ...result, done: true, unavailable: true, elapsedMs: performance.now() - started };
  }
  // Limit identities before checking coverage: an already covered long session must
  // not turn one writer reservation into an unbounded anti-join scan on restart.
  const identities = iterateSqliteQuerySync(
    database,
    db
      .selectFrom("session_transcript_active_events as active")
      .leftJoin("session_transcript_active_event_facts as facts", (join) =>
        join
          .onRef("facts.session_id", "=", "active.session_id")
          .onRef("facts.seq", "=", "active.event_seq"),
      )
      .select(["active.active_position", "active.event_seq", "facts.seq as covered"])
      .where("active.session_id", "=", cursor.sessionId)
      .where("active.active_position", ">", cursor.afterPosition)
      .orderBy("active.active_position")
      .limit(MAX_IDENTITY_ROWS),
  );
  let payloadRows = 0;
  let exhausted = true;
  for (const identity of identities) {
    if (
      result.rowsVisited > 0 &&
      (performance.now() - started >= MAX_BATCH_MS ||
        payloadRows >= MAX_PAYLOAD_ROWS ||
        result.bytesRead >= MAX_PAYLOAD_BYTES)
    ) {
      exhausted = false;
      break;
    }
    result.rowsVisited++;
    result.afterPosition = identity.active_position;
    if (identity.covered !== null) {
      continue;
    }
    payloadRows++;
    const facts = executeSqliteQueryTakeFirstSync(
      database,
      db
        .selectFrom("session_transcript_active_events as active")
        .innerJoin("transcript_events as event", (join) =>
          join
            .onRef("event.session_id", "=", "active.session_id")
            .onRef("event.seq", "=", "active.event_seq"),
        )
        .select((eb) => [
          transcriptEventReadBytesSql("event").$castTo<number | null>().as("bytes"),
          /* kysely-allow-raw: legacy malformed payloads remain unknown under the writer's native projection guard. */
          sql<
            string | null
          >`CASE WHEN ${transcriptDependencyFactsProjectableSql(database, "event")} AND ${transcriptPredicateSql(database, "navigation_valid", "event")} = 1 THEN ${transcriptEventDependencyNavigationSql(database, eb.ref("active.context_eligible"), "event")} ELSE NULL END`.as(
            "navigation",
          ),
        ])
        .where("active.session_id", "=", cursor.sessionId)
        .where("active.active_position", "=", identity.active_position)
        .where("active.event_seq", "=", identity.event_seq)
        .where("active.context_eligible", "is not", null)
        .where((eb) =>
          eb.or([eb("event.event_json", "is not", null), eb("event.event_zstd", "is not", null)]),
        ),
    );
    result.bytesRead += facts?.bytes ?? 0;
    if (!facts || facts.navigation === null || facts.bytes === null) {
      result.rowsSkipped++;
      continue;
    }
    const { bytes, navigation } = facts;
    withSqliteDatabaseWriteScope(database, [sqliteSessionIdWriteScope(cursor.sessionId)], () =>
      executeSqliteQuerySync(
        database,
        db.insertInto("session_transcript_active_event_facts").values({
          session_id: cursor.sessionId,
          seq: identity.event_seq,
          serialized_bytes: bytes + 1,
          dependency_navigation_json: navigation,
        }),
      ),
    );
    result.rowsFilled++;
  }
  // One indivisible cold payload can exceed either budget; never start another
  // payload after it. No payload or prepared fact survives this transaction.
  result.done = exhausted && result.rowsVisited < MAX_IDENTITY_ROWS;
  result.elapsedMs = performance.now() - started;
  return result;
}

export type TranscriptActiveFactsBackfillOperations = {
  discover: {
    input: undefined;
    output: { supported: boolean; sessions: TranscriptActiveFactsBackfillSession[] };
  };
  batch: { input: TranscriptActiveFactsBackfillCursor; output: TranscriptActiveFactsBackfillBatch };
};

export function bindSqliteWorkerBackend(_input: undefined, context: SqliteWorkerDatabaseContext) {
  const database = context.database;
  return bindSqliteWorkerDatabase<TranscriptActiveFactsBackfillOperations>(database, {
    execute(command: SqliteWorkerCommand<TranscriptActiveFactsBackfillOperations>) {
      // PostgreSQL needs a separately measured source-row locking protocol; its
      // ordinary writers continue filling facts through the existing owner.
      if (command.type === "discover") {
        return isPostgresSqlConnection(database)
          ? { supported: false, sessions: [] }
          : { supported: true, sessions: discoverTranscriptActiveFactsBackfillSessions(database) };
      }
      if (isPostgresSqlConnection(database)) {
        throw new Error("Transcript facts background backfill currently supports SQLite only");
      }
      context.admit("transaction");
      context.admit("commit");
      let entered = false;
      const started = performance.now();
      try {
        const result = runWithSqliteBusyTimeout(database, 0, () =>
          runSqliteImmediateTransactionSync(
            database,
            () => {
              entered = true;
              return backfillTranscriptActiveFactsBatchInTransaction(database, command.input);
            },
            {
              operationLabel: "sessions.transcript-facts-backfill",
              beginLockFailureReporting: "suppress",
            },
          ),
        );
        return { ...result, elapsedMs: performance.now() - started };
      } catch (error) {
        if (entered || !isSqliteLockError(error)) {
          throw error;
        }
        return {
          afterPosition: command.input.afterPosition,
          done: false,
          unavailable: false,
          busy: true,
          rowsFilled: 0,
          rowsSkipped: 0,
          rowsVisited: 0,
          bytesRead: 0,
          elapsedMs: performance.now() - started,
        };
      }
    },
  });
}
