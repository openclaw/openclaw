import { createHash } from "node:crypto";
import { iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../../infra/sqlite-number.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { SqliteTranscriptSnapshotRow } from "./session-accessor.sqlite-read.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { readHotSessionTranscriptSnapshot } from "./session-cold-storage-state.js";
import { SqliteTranscriptMutationConflictError } from "./session-mutation-conflict-error.js";
import { readTranscriptPayload } from "./transcript-payload.js";

export function visitTranscriptEventRows(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
  visit: (row: SqliteTranscriptSnapshotRow) => void,
): void {
  readHotSessionTranscriptSnapshot(database, sessionId, "raw rows", () => {
    const query = getSessionKysely(database.db)
      .selectFrom("transcript_events")
      .select(["event_json", "event_zstd", "event_utf8_bytes", "seq"])
      .where("session_id", "=", sessionId)
      .orderBy("seq", "asc");
    for (const row of iterateSqliteQuerySync(database.db, query)) {
      visit({ eventJson: readTranscriptPayload(row), seq: sqliteNumber(row.seq) });
    }
  });
}

export type SqliteTranscriptSnapshotDigest = { count: number; sha256: string };

/** Keep byte/sequence stale-write checks without retaining the discarded transcript. */
export function readTranscriptEventRowsDigest(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
  visit?: (row: SqliteTranscriptSnapshotRow) => void,
): SqliteTranscriptSnapshotDigest {
  const hash = createHash("sha256");
  let count = 0;
  visitTranscriptEventRows(database, sessionId, (row) => {
    hash.update(JSON.stringify([row.seq, row.eventJson]));
    count++;
    visit?.(row);
  });
  return { count, sha256: hash.digest("hex") };
}

export function assertSqliteTranscriptDigestUnchanged(
  database: OpenClawAgentDatabase,
  sessionId: string,
  expected: SqliteTranscriptSnapshotDigest,
): void {
  const current = readTranscriptEventRowsDigest(database, sessionId);
  if (current.count !== expected.count || current.sha256 !== expected.sha256) {
    throw new SqliteTranscriptMutationConflictError(sessionId);
  }
}
