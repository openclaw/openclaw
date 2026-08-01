import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  SessionTranscriptEventRow,
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import { normalizeSqliteNumber } from "./session-accessor.sqlite-normalize.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptRestorableMessageNodes,
} from "./transcript-tree.js";

export type SessionTranscriptRestorableMessageSnapshot = {
  events: SessionTranscriptEventRow[];
  generation: string | null;
  maxSeq: number | null;
};

/**
 * Reads restorable branch messages and their cache watermark from one SQLite snapshot.
 *
 * Branch/reset policy belongs to the session store; gateway retention callers must
 * not infer it from raw transcript rows.
 */
export function readSessionTranscriptRestorableMessageSnapshot(
  scope: SessionTranscriptReadScope,
): SessionTranscriptRestorableMessageSnapshot {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      const db = getSessionKysely(database.db);
      const generation =
        executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("transcript_rewrite_watermarks")
            .select("generation")
            .where("session_id", "=", resolved.sessionId),
        )?.generation ?? null;
      const rows = executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("transcript_events")
          .select(["event_json", "seq"])
          .where("session_id", "=", resolved.sessionId)
          .orderBy("seq", "asc"),
      ).rows.map((row) => ({
        event: JSON.parse(row.event_json) as TranscriptEvent,
        seq: normalizeSqliteNumber(row.seq),
      }));
      const tree = scanSessionTranscriptTree(rows.map((row) => row.event));
      return {
        events: selectSessionTranscriptRestorableMessageNodes(tree).flatMap(
          (node) => rows[node.index] ?? [],
        ),
        generation,
        maxSeq: rows.at(-1)?.seq ?? null,
      };
    },
    {
      databaseLabel: database.path,
      operationLabel: "sessions.transcript.restorable-messages.read",
    },
  );
}
