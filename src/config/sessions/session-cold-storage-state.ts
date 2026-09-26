import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import { getNodeSqliteKysely, prepareSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";

export type SessionColdArchive = Selectable<DB["session_transcript_cold_archives"]>;

function createColdTranscriptQueries(db: DatabaseSync) {
  const kysely = getNodeSqliteKysely<DB>(db);
  return {
    metadata: prepareSqliteQuerySync<string, Omit<SessionColdArchive, "archive_blob">>(
      db,
      (parameter) =>
        kysely
          .selectFrom("session_transcript_cold_archives")
          .select([
            "session_id",
            "generation",
            "archive_name",
            "archive_sha256",
            "event_count",
            "raw_bytes",
            "archive_bytes",
            "last_seq",
            "archived_at",
            "storage",
          ])
          .where(
            "session_id",
            "=",
            parameter((sessionId) => sessionId),
          ),
    ),
    marker: prepareSqliteQuerySync<string, { session_id: string }>(db, (parameter) =>
      kysely
        .selectFrom("session_transcript_cold_archives")
        .select("session_id")
        .where(
          "session_id",
          "=",
          parameter((sessionId) => sessionId),
        ),
    ),
  };
}

const coldTranscriptQueries = new WeakMap<
  DatabaseSync,
  ReturnType<typeof createColdTranscriptQueries>
>();

function getColdTranscriptQueries(db: DatabaseSync) {
  let queries = coldTranscriptQueries.get(db);
  if (!queries) {
    queries = createColdTranscriptQueries(db);
    coldTranscriptQueries.set(db, queries);
  }
  return queries;
}

export function readSessionColdTranscript(
  db: DatabaseSync,
  sessionId: string,
): Omit<SessionColdArchive, "archive_blob"> | undefined {
  return getColdTranscriptQueries(db).metadata(sessionId).rows[0];
}

export class SessionTranscriptColdError extends Error {
  readonly code = "TRANSCRIPT_COLD";
  constructor(readonly sessionId: string) {
    super(
      `Transcript ${sessionId} is in cold storage. Restore its archive before reading or changing the transcript.`,
    );
    this.name = "SessionTranscriptColdError";
  }
}

export function assertSessionTranscriptHot(db: DatabaseSync, sessionId: string): void {
  if (getColdTranscriptQueries(db).marker(sessionId).rows.length > 0) {
    throw new SessionTranscriptColdError(sessionId);
  }
}
