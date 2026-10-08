import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { repairCanonicalSessionKeys as repairSessionKeys } from "./doctor-session-canonical-keys.js";

export async function repairCanonicalSessionKeys(params: Parameters<typeof repairSessionKeys>[0]) {
  if (!params.apply) {
    return repairSessionKeys(params);
  }
  // Match Doctor's offline owner; runtime admission must not inspect partly repaired rows.
  const { withDoctorSqliteMaintenanceLock } = await import("./doctor-sqlite-maintenance-lock.js");
  return withDoctorSqliteMaintenanceLock({
    env: params.env,
    operation: "session SQLite import",
    run: () => repairSessionKeys(params),
  });
}

export function insertLegacySession(params: {
  agentId: string;
  entry: SessionEntry;
  env: NodeJS.ProcessEnv;
  eventText?: string;
  sessionKey: string;
  storePath: string;
}): void {
  const database = openOpenClawAgentDatabase({
    agentId: params.agentId,
    env: params.env,
    path: resolveSqliteTargetFromSessionStorePath(params.storePath, {
      agentId: params.agentId,
      env: params.env,
    }).path,
  });
  database.db
    .prepare(
      "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run(
      params.sessionKey,
      params.entry.sessionId,
      JSON.stringify(params.entry),
      params.entry.updatedAt,
    );
  database.db
    .prepare(
      "INSERT INTO session_windows (session_id, session_key, reason, session_scope, created_at, updated_at) VALUES (?, ?, 'initial', 'conversation', ?, ?)",
    )
    .run(params.entry.sessionId, params.sessionKey, params.entry.updatedAt, params.entry.updatedAt);
  if (!params.eventText) {
    return;
  }
  database.db
    .prepare(
      "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, 0, ?, ?)",
    )
    .run(
      params.entry.sessionId,
      JSON.stringify({
        id: `${params.entry.sessionId}-message`,
        message: { content: params.eventText, role: "user" },
        parentId: null,
        type: "message",
      }),
      params.entry.updatedAt,
    );
}
