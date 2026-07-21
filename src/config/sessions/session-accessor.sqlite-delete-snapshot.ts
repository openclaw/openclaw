import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { SqliteSessionStateDeleteSnapshot } from "./session-accessor.sqlite-archive.js";

type SessionStateDeleteSnapshotDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  | "acp_parent_stream_events"
  | "sessions"
  | "session_transcript_generations"
  | "trajectory_runtime_events"
  | "transcript_events"
>;

function normalizeOptionalSqliteNumber(value: number | bigint | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/** Captures canonical state that supported writers can mutate outside the session writer queue. */
export function readSqliteSessionStateDeleteSnapshot(
  database: import("node:sqlite").DatabaseSync,
  sessionId: string,
): SqliteSessionStateDeleteSnapshot {
  const db = getNodeSqliteKysely<SessionStateDeleteSnapshotDatabase>(database);
  const session = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("sessions")
      .select(["transcript_updated_at", "updated_at"])
      .where("session_id", "=", sessionId),
  );
  const generation = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("session_transcript_generations")
      .select("generation")
      .where("session_id", "=", sessionId),
  );
  const lastEvent = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("transcript_events")
      .select("seq")
      .where("session_id", "=", sessionId)
      .orderBy("seq", "desc")
      .limit(1),
  );
  const lastTrajectory = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("trajectory_runtime_events")
      .select("seq")
      .where("session_id", "=", sessionId)
      .orderBy("seq", "desc")
      .limit(1),
  );
  const acpParentStream = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("acp_parent_stream_events")
      .select((eb) => eb.fn.countAll<number | bigint>().as("event_count"))
      .where("session_id", "=", sessionId),
  );
  return {
    acpParentStreamEventCount: normalizeOptionalSqliteNumber(acpParentStream?.event_count) ?? 0,
    generation: generation?.generation ?? null,
    lastSeq: lastEvent?.seq ?? null,
    sessionUpdatedAt: session?.updated_at ?? null,
    trajectoryLastSeq: lastTrajectory?.seq ?? null,
    transcriptUpdatedAt: session?.transcript_updated_at ?? null,
  };
}
