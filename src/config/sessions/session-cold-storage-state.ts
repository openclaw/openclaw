import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";

export type SessionColdArchive = Selectable<DB["session_transcript_cold_archives"]>;

export function readSessionColdTranscript(
  db: DatabaseSync,
  sessionId: string,
): Omit<SessionColdArchive, "archive_blob"> | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<DB>(db)
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
      .where("session_id", "=", sessionId),
  );
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
  if (
    executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<DB>(db)
        .selectFrom("session_transcript_cold_archives")
        .select("session_id")
        .where("session_id", "=", sessionId),
    )
  ) {
    throw new SessionTranscriptColdError(sessionId);
  }
}
