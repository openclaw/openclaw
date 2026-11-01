import { sql } from "kysely";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { SessionTranscriptContextVersion } from "./session-accessor.sqlite-contract.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { readSessionActorTransactionState } from "./session-actor-transaction.js";
import { readTranscriptContextFacts } from "./session-transcript-context-facts.js";

/** Retain actor facts and empty/cold semantics while reading a selected batch in one statement. */
export function readTranscriptContextVersionsInTransaction(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionIds: readonly string[],
): SessionTranscriptContextVersion[] {
  const versions = new Map<string, SessionTranscriptContextVersion>();
  const missing: string[] = [];
  for (const sessionId of new Set(sessionIds)) {
    const actor = readSessionActorTransactionState(database, { sessionId });
    const version =
      actor?.hot.transcript.version ?? readTranscriptContextFacts(database, sessionId)?.version;
    if (version) {
      versions.set(sessionId, version);
    } else {
      missing.push(sessionId);
    }
  }
  // Inline cleanup can be exhaustive; keep its statement bindings bounded too.
  for (let offset = 0; offset < missing.length; offset += 64) {
    const batch = missing.slice(offset, offset + 64);
    const rows = executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .with(
          "target(session_id)",
          () =>
            /* kysely-allow-raw: A bound VALUES relation preserves absent transcript roots on both engines. */
            sql<{ session_id: string }>`(VALUES ${sql.join(batch.map((id) => sql`(${id})`))})`,
        )
        .selectFrom("target")
        .leftJoin(
          "session_transcript_cold_archives as cold",
          "cold.session_id",
          "target.session_id",
        )
        .leftJoin(
          "transcript_rewrite_watermarks as watermark",
          "watermark.session_id",
          "target.session_id",
        )
        .leftJoin("session_windows as window", "window.session_id", "target.session_id")
        .select((eb) => [
          "target.session_id",
          eb.fn
            .coalesce(
              "cold.last_seq",
              eb
                .selectFrom("transcript_events")
                .select((events) => events.fn.max<number | null>("seq").as("seq"))
                .whereRef("transcript_events.session_id", "=", "target.session_id"),
            )
            .as("rawSeq"),
          "watermark.generation as generation",
          "window.transcript_updated_at as updatedAt",
        ]),
    ).rows;
    for (const { session_id, ...version } of rows) {
      versions.set(session_id, version);
    }
  }
  return sessionIds.map((id) => ({ ...versions.get(id)! }));
}
