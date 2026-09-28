import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";

// Frozen from f69617aa3818d805889692918ee7f51bef666597 as the original schema-21 migration input.
// Historical migration inputs must not inherit the current runtime's new column definitions.
export const OPENCLAW_AGENT_SCHEMA_V21_SQL = fs.readFileSync(
  new URL("../../test/fixtures/sqlite/openclaw-agent-schema-v21.sql", import.meta.url),
  "utf8",
);

export function seedOpenClawAgentSchemaV21(database: DatabaseSync, agentId = "main"): void {
  database.exec(OPENCLAW_AGENT_SCHEMA_V21_SQL);
  database.exec("PRAGMA user_version = 21");
  database
    .prepare(`INSERT INTO schema_meta
    (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
    VALUES ('primary', 'agent', 21, ?, '2026.9.4', 1, 1)`)
    .run(agentId);
}

export function materializeV21WorkerAgentDatabase(stateDir: string): string {
  const databasePath = resolveOpenClawAgentSqlitePath({
    agentId: "worker-1",
    env: { OPENCLAW_STATE_DIR: stateDir },
  });
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new (requireNodeSqlite().DatabaseSync)(databasePath);
  try {
    seedOpenClawAgentSchemaV21(database, "worker-1");
  } finally {
    database.close();
  }
  return databasePath;
}

/** Preserve session/board setup while replacing unused compact storage with its frozen old shape. */
export function restoreEmptyV21StorageForHistoricalFixture(database: DatabaseSync): void {
  const tables = [
    "transcript_events",
    "memory_index_chunks",
    "memory_embedding_cache",
    "session_transcript_fts_rows",
  ];
  for (const table of tables) {
    if (database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) {
      throw new Error(`Historical fixture must not discard ${table} data`);
    }
  }
  const foreignKeys = database.prepare("PRAGMA foreign_keys").get()?.foreign_keys;
  database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
  try {
    for (const table of tables) {
      database.exec(`DROP TABLE ${table}`);
    }
    database.exec(OPENCLAW_AGENT_SCHEMA_V21_SQL);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    if (foreignKeys === 1) {
      database.exec("PRAGMA foreign_keys = ON");
    }
  }
}
