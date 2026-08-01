import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  readSqliteTranscriptRowsForFork,
  resolveSqliteCheckpointTranscriptForkSources,
} from "./session-accessor.sqlite-checkpoint.js";
import type {
  SessionTranscriptEventRow,
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { normalizeSqliteNumber } from "./session-accessor.sqlite-normalize.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptRetainedMessageNodes,
  selectSessionTranscriptRestorableMessageNodes,
} from "./transcript-tree.js";

export type SessionTranscriptRestorableMessageSnapshot = {
  artifactRetentionComplete: boolean;
  events: SessionTranscriptEventRow[];
  retainedEvents: SessionTranscriptEventRow[];
  generation: string | null;
  maxSeq: number | null;
};

/**
 * Reads restorable and artifact-retained branch messages from one SQLite snapshot.
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
      const retainedEvents = new Map<string, SessionTranscriptEventRow>();
      for (const node of selectSessionTranscriptRetainedMessageNodes(tree)) {
        const row = rows[node.index];
        if (row) {
          retainedEvents.set(`${resolved.sessionId}:${row.seq}`, row);
        }
      }
      const entry = resolved.sessionKey
        ? readSessionEntryRow(database, resolved.sessionKey)?.entry
        : undefined;
      const entryMatchesScope = entry?.sessionId === resolved.sessionId;
      let artifactRetentionComplete = entryMatchesScope;
      if (entryMatchesScope) {
        for (const checkpoint of entry.compactionCheckpoints ?? []) {
          artifactRetentionComplete &&= ![
            checkpoint.preCompaction.sessionFile,
            checkpoint.postCompaction.sessionFile,
          ].some((sessionFile) => Boolean(sessionFile?.trim()));
          for (const source of resolveSqliteCheckpointTranscriptForkSources(checkpoint)) {
            const sourceRows = readSqliteTranscriptRowsForFork(database, source);
            if (sourceRows.status !== "created") {
              artifactRetentionComplete = false;
              continue;
            }
            const sourceTree = scanSessionTranscriptTree(sourceRows.rows.map((row) => row.event));
            for (const node of selectSessionTranscriptRetainedMessageNodes(sourceTree)) {
              const row = sourceRows.rows[node.index];
              if (row) {
                retainedEvents.set(`${source.sessionId}:${row.seq}`, row);
              }
            }
          }
        }
      }
      return {
        artifactRetentionComplete,
        events: selectSessionTranscriptRestorableMessageNodes(tree).flatMap(
          (node) => rows[node.index] ?? [],
        ),
        retainedEvents: [...retainedEvents.values()],
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
