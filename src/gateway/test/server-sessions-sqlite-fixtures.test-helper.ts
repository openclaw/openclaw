import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";

export function writeSessionEntryJsonWithoutSessionId(params: {
  storePath: string;
  sessionKey: string;
  sessionId: string;
  entryJson: Record<string, unknown>;
  updatedAt: number;
}): void {
  const target = resolveSqliteTargetFromSessionStorePath(params.storePath, { agentId: "main" });
  const database = openOpenClawAgentDatabase({
    agentId: target.agentId ?? "main",
    path: target.path,
  });
  database.db
    .prepare(
      `INSERT INTO sessions (
        session_id, session_key, session_scope, created_at, updated_at, status
      ) VALUES (?, ?, 'conversation', ?, ?, ?)`,
    )
    .run(
      params.sessionId,
      params.sessionKey,
      params.updatedAt,
      params.updatedAt,
      typeof params.entryJson.status === "string" ? params.entryJson.status : null,
    );
  database.db
    .prepare(
      `INSERT INTO session_entries (
        session_key, session_id, entry_json, updated_at, status
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      params.sessionKey,
      params.sessionId,
      JSON.stringify(params.entryJson),
      params.updatedAt,
      typeof params.entryJson.status === "string" ? params.entryJson.status : null,
    );
}
