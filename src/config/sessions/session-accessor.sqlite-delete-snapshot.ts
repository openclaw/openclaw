import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../../infra/sqlite-number.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { SessionStateDeletePlan } from "./session-accessor.sqlite-archive-types.js";
import type { SessionStateDeleteSnapshot } from "./session-accessor.sqlite-delete-snapshot.types.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";

export function sqliteSessionStateDeleteSnapshotsEqual(
  left: SessionStateDeleteSnapshot,
  right: SessionStateDeleteSnapshot,
): boolean {
  return (
    left.acpParentStreamEventCount === right.acpParentStreamEventCount &&
    left.generation === right.generation &&
    left.lastSeq === right.lastSeq &&
    left.sessionKey === right.sessionKey &&
    left.sessionUpdatedAt === right.sessionUpdatedAt &&
    left.trajectoryLastSeq === right.trajectoryLastSeq &&
    left.transcriptUpdatedAt === right.transcriptUpdatedAt
  );
}

type SessionStateDeleteSnapshotDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  | "acp_parent_stream_events"
  | "session_windows"
  | "trajectory_runtime_events"
  | "transcript_events"
  | "transcript_rewrite_watermarks"
>;

/** Captures the owner window and canonical child state writable outside the lifecycle queue. */
export function readSessionStateDeleteSnapshot(
  database: import("node:sqlite").DatabaseSync,
  sessionId: string,
): SessionStateDeleteSnapshot {
  const db = getNodeSqliteKysely<SessionStateDeleteSnapshotDatabase>(database);
  // The target survives a missing window so orphaned child state still fences deletion.
  const target = db.selectNoFrom((eb) => eb.val(sessionId).as("session_id")).as("target");
  const snapshot = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom(target)
      .leftJoin("session_windows as window", "window.session_id", "target.session_id")
      .leftJoin(
        "transcript_rewrite_watermarks as watermark",
        "watermark.session_id",
        "target.session_id",
      )
      .select([
        "window.session_key",
        "window.transcript_updated_at",
        "window.updated_at",
        "watermark.generation",
      ])
      .select((eb) => [
        eb
          .selectFrom("transcript_events")
          .select("seq")
          .whereRef("transcript_events.session_id", "=", "target.session_id")
          .orderBy("seq", "desc")
          .limit(1)
          .as("last_seq"),
        eb
          .selectFrom("trajectory_runtime_events")
          .select("seq")
          .whereRef("trajectory_runtime_events.session_id", "=", "target.session_id")
          .orderBy("seq", "desc")
          .limit(1)
          .as("trajectory_last_seq"),
        eb
          .selectFrom("acp_parent_stream_events")
          .select((inner) => inner.fn.countAll<number | bigint>().as("event_count"))
          .whereRef("acp_parent_stream_events.session_id", "=", "target.session_id")
          .as("acp_parent_stream_event_count"),
      ]),
  );
  return {
    acpParentStreamEventCount: sqliteNumber(snapshot?.acp_parent_stream_event_count ?? 0),
    generation: snapshot?.generation ?? null,
    lastSeq: snapshot?.last_seq ?? null,
    sessionKey: snapshot?.session_key ?? null,
    sessionUpdatedAt: snapshot?.updated_at ?? null,
    trajectoryLastSeq: snapshot?.trajectory_last_seq ?? null,
    transcriptUpdatedAt: snapshot?.transcript_updated_at ?? null,
  };
}

export function planSessionStateDeleteIfUnreferenced(params: {
  archiveTranscript?: boolean;
  archiveDirectory: string;
  database: Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">;
  reason?: "deleted" | "reset";
  referencedSessionIds: ReadonlySet<string>;
  sessionId: string;
}): SessionStateDeletePlan | null {
  if (
    params.referencedSessionIds.has(params.sessionId) ||
    readSessionColdTranscript(params.database.db, params.sessionId)
  ) {
    return null;
  }
  return {
    agentId: params.database.agentId,
    archiveDirectory: params.archiveDirectory,
    archiveTranscript:
      params.archiveTranscript !== false &&
      typeof readOpenClawAgentDatabaseIdentity(params.database).identity === "string",
    databasePath: params.database.path,
    reason: params.reason ?? "deleted",
    sessionId: params.sessionId,
    snapshot: readSessionStateDeleteSnapshot(params.database.db, params.sessionId),
  };
}
