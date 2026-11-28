import type { SqlConnection } from "../infra/sql-connection.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import {
  type DoctorSqliteMaintenanceAuthority,
  withDoctorSqliteMaintenanceLock,
} from "./doctor-sqlite-maintenance-lock.js";

export function withSessionEntryMaintenance<T>(
  env: NodeJS.ProcessEnv,
  run: (authority: DoctorSqliteMaintenanceAuthority) => Promise<T> | T,
) {
  return withDoctorSqliteMaintenanceLock({ env, operation: "session entry test", run });
}

/** Seed one raw session row so Doctor sees the entry exactly as stored. */
export function seedSessionEntry(
  env: NodeJS.ProcessEnv,
  key: string,
  fields: Record<string, unknown>,
) {
  const sessionKey = `agent:main:${key}`;
  const entry = {
    sessionId: `session-${key}`,
    updatedAt: 42,
    delivery: { kind: "none" },
    ...fields,
  };
  const raw = JSON.stringify(entry);
  const agentDatabase = () => openOpenClawAgentDatabase({ agentId: "main", env });
  const database = agentDatabase();
  database.db
    .prepare(
      "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run(sessionKey, entry.sessionId, raw, entry.updatedAt);
  database.db
    .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
    .run(sessionKey);
  database.db
    .prepare(
      "INSERT INTO session_windows (session_id, session_key, session_scope, created_at, updated_at) VALUES (?, ?, 'conversation', ?, ?)",
    )
    .run(entry.sessionId, sessionKey, entry.updatedAt, entry.updatedAt);
  const readStored = (connection: Pick<SqlConnection, "prepare">) =>
    connection.prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?").get(sessionKey)
      ?.entry_json;
  const readRaw = () => readStored(agentDatabase().db);
  return {
    raw,
    readRaw,
    readStored,
    read: () => JSON.parse(String(readRaw())),
    sessionKey,
    databasePath: database.path,
    scope: { agentId: "main", env, sessionKey, storePath: database.path },
    writeRaw: (value: string) =>
      agentDatabase()
        .db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
        .run(value, sessionKey),
    row: (columns: string, table = "session_nodes") =>
      agentDatabase()
        .db.prepare(`SELECT ${columns} FROM ${table} WHERE session_key = ?`)
        .get(sessionKey),
  };
}
