import {
  createSqliteQueryCache,
  executeSqliteQueryTakeFirstSync,
  prepareSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { getSqliteReadScopeRevision } from "../../infra/sqlite-schema-facts.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { SessionTranscriptContextVersion } from "./session-accessor.sqlite-contract.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope-helpers.js";
import { readSessionActorTransactionState } from "./session-actor-transaction.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import {
  readTranscriptContextFacts,
  retainTranscriptContextFacts,
} from "./session-transcript-context-facts.js";

const transcriptContextVersionQuery = createSqliteQueryCache((database: EngineConnection) => {
  const db = getSessionKysely(database);
  return prepareSqliteQueryTakeFirstSync<
    string,
    SessionTranscriptContextVersion & { cold: number }
  >(database, (parameter) =>
    db
      .selectFrom("transcript_events")
      .select((eb) => [
        eb.fn
          .coalesce(
            eb
              .selectFrom("session_transcript_cold_archives")
              .select("last_seq")
              .where(
                "session_id",
                "=",
                parameter((sessionId) => sessionId),
              ),
            eb.fn.max<number | null>("seq"),
          )
          .as("rawSeq"),
        eb
          .selectFrom("transcript_rewrite_watermarks")
          .select("generation")
          .where(
            "session_id",
            "=",
            parameter((sessionId) => sessionId),
          )
          .as("generation"),
        eb
          .selectFrom("session_windows")
          .select("transcript_updated_at")
          .where(
            "session_id",
            "=",
            parameter((sessionId) => sessionId),
          )
          .as("updatedAt"),
        eb
          .exists(
            eb
              .selectFrom("session_transcript_cold_archives")
              .select("session_id")
              .where(
                "session_id",
                "=",
                parameter((sessionId) => sessionId),
              ),
          )
          .as("cold"),
      ])
      .where(
        "session_id",
        "=",
        parameter((sessionId) => sessionId),
      ),
  );
});

function readContextState(database: Pick<OpenClawAgentDatabase, "db">, sessionId: string) {
  const revision = getSqliteReadScopeRevision(database.db);
  const { cold, ...version } = transcriptContextVersionQuery(database.db)(sessionId)!;
  retainTranscriptContextFacts(database, sessionId, version, revision, Boolean(cold));
  return { version, cold: Boolean(cold) };
}

export function readTranscriptContextVersionInTransaction(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
) {
  const actor = readSessionActorTransactionState(database, { sessionId });
  if (actor) {
    return { ...actor.hot.transcript.version };
  }
  return {
    ...(readTranscriptContextFacts(database, sessionId)?.version ??
      readContextState(database, sessionId).version),
  };
}

/** Preparation consumes cold presence and the matching version from one read phase. */
export function readTranscriptContextStateInTransaction(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
) {
  const actor = readSessionActorTransactionState(database, { sessionId });
  if (actor) {
    return {
      coldArchive: actor.transcript.coldArchive,
      version: { ...actor.hot.transcript.version },
    };
  }
  const retained = readTranscriptContextFacts(database, sessionId);
  const state = retained?.cold === undefined ? readContextState(database, sessionId) : retained;
  return {
    coldArchive: state.cold ? readSessionColdTranscript(database.db, sessionId) : undefined,
    version: { ...state.version },
  };
}

/** Read the current raw transcript generation inside the caller's transaction. */
export function readTranscriptGenerationInTransaction(
  database: OpenClawAgentDatabase,
  sessionId: string,
): string | undefined {
  const actor = readSessionActorTransactionState(database, { sessionId });
  if (actor) {
    return actor.hot.transcript.version.generation ?? undefined;
  }
  const db = getSessionKysely(database.db);
  return executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_rewrite_watermarks")
      .select("generation")
      .where("session_id", "=", sessionId),
  )?.generation;
}
