import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import {
  createSqliteQueryCache,
  getNodeSqliteKysely,
  prepareSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import { readSessionActorTransactionState } from "./session-actor-transaction.js";
import { readTranscriptContextFacts } from "./session-transcript-context-facts.js";

export type SessionColdArchive = Selectable<DB["session_transcript_cold_archives"]>;

export const sessionColdArchiveMetadataColumns = [
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
] as const;

function createColdTranscriptQueries(db: DatabaseSync) {
  const kysely = getNodeSqliteKysely<DB>(db);
  return {
    metadata: prepareSqliteQuerySync<string, Omit<SessionColdArchive, "archive_blob">>(
      db,
      (parameter) =>
        kysely
          .selectFrom("session_transcript_cold_archives")
          .select(sessionColdArchiveMetadataColumns)
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

const getColdTranscriptQueries = createSqliteQueryCache(createColdTranscriptQueries);

export function readSessionColdTranscript(
  db: DatabaseSync,
  sessionId: string,
): Omit<SessionColdArchive, "archive_blob"> | undefined {
  const actor = readSessionActorTransactionState({ db }, { sessionId });
  if (actor) {
    return actor.transcript.coldArchive && { ...actor.transcript.coldArchive };
  }
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
  const actor = readSessionActorTransactionState({ db }, { sessionId });
  if (actor) {
    if (actor.transcript.coldArchive) {
      throw new SessionTranscriptColdError(sessionId);
    }
    return;
  }
  const context = readTranscriptContextFacts({ db }, sessionId);
  if (context?.cold === false) {
    return;
  }
  if (context?.cold || getColdTranscriptQueries(db).marker(sessionId).rows.length > 0) {
    throw new SessionTranscriptColdError(sessionId);
  }
}
