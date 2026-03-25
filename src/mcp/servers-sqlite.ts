/**
 * SQLite adapter for MCP servers (replaces ~/.openclaw/mcp/servers.yaml).
 *
 * Servers are keyed by (key, scope) and stored as JSON blobs.
 * Scope values: "user" | "project" | "local"
 */
import type { DatabaseSync } from "node:sqlite";
import { getStateDb } from "../infra/state-db/connection.js";
import type { McpScope, McpServerConfig } from "./types.js";

// ── DB provider (overridable for tests) ──────────────────────────────────────

let _dbOverride: DatabaseSync | null = null;

export function setMcpServersDbForTest(db: DatabaseSync): void {
  _dbOverride = db;
}

export function resetMcpServersDbForTest(): void {
  _dbOverride = null;
}

function resolveDb(): DatabaseSync {
  return _dbOverride ?? getStateDb();
}

// ── Read ─────────────────────────────────────────────────────────────────────

/**
 * Load all servers for a given scope, returning a keyed record.
 * Returns an empty object if no rows exist.
 */
export function loadMcpServersFromDb(scope: McpScope): Record<string, McpServerConfig> {
  const db = resolveDb();
  const rows = db
    .prepare(
      "SELECT key, config_json, enabled FROM op1_mcp_servers WHERE scope = ? ORDER BY key",
    )
    .all(scope) as Array<{ key: string; config_json: string; enabled: number }>;

  const result: Record<string, McpServerConfig> = {};
  for (const row of rows) {
    try {
      const config = JSON.parse(row.config_json) as McpServerConfig;
      // Merge the enabled flag from the DB column (authoritative) into the config.
      if (row.enabled === 0) {
        config.enabled = false;
      } else if (config.enabled === undefined) {
        config.enabled = true;
      }
      result[row.key] = config;
    } catch {
      // Skip rows with malformed JSON — best-effort.
    }
  }
  return result;
}

// ── Write ────────────────────────────────────────────────────────────────────

/**
 * Upsert a single server config into the DB for the given scope.
 */
export function saveMcpServerToDb(
  scope: McpScope,
  key: string,
  config: McpServerConfig,
): void {
  const db = resolveDb();
  const enabled = config.enabled !== false ? 1 : 0;
  db.prepare(
    `INSERT INTO op1_mcp_servers (key, scope, type, config_json, enabled, updated_at)
     VALUES (?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(key, scope) DO UPDATE SET
       type       = excluded.type,
       config_json = excluded.config_json,
       enabled    = excluded.enabled,
       updated_at = unixepoch()`,
  ).run(key, scope, config.type, JSON.stringify(config), enabled);
}

/**
 * Delete a server from the DB. Returns true if a row was deleted.
 */
export function deleteMcpServerFromDb(scope: McpScope, key: string): boolean {
  const db = resolveDb();
  const result = db
    .prepare("DELETE FROM op1_mcp_servers WHERE key = ? AND scope = ?")
    .run(key, scope);
  return (result.changes as number) > 0;
}

/**
 * List all servers across every scope (for admin / listing RPCs).
 */
export function listAllMcpServersFromDb(): Array<{
  key: string;
  scope: McpScope;
  type: string;
  config: McpServerConfig;
  enabled: boolean;
}> {
  const db = resolveDb();
  const rows = db
    .prepare(
      "SELECT key, scope, type, config_json, enabled FROM op1_mcp_servers ORDER BY scope, key",
    )
    .all() as Array<{
    key: string;
    scope: string;
    type: string;
    config_json: string;
    enabled: number;
  }>;

  return rows.flatMap((row) => {
    try {
      return [
        {
          key: row.key,
          scope: row.scope as McpScope,
          type: row.type,
          config: JSON.parse(row.config_json) as McpServerConfig,
          enabled: row.enabled !== 0,
        },
      ];
    } catch {
      return [];
    }
  });
}

/**
 * Check whether any rows exist for a scope (used to detect whether migration
 * from YAML has already been performed).
 */
export function hasMcpServersInDb(scope: McpScope): boolean {
  const db = resolveDb();
  try {
    const row = db
      .prepare("SELECT COUNT(*) as n FROM op1_mcp_servers WHERE scope = ?")
      .get(scope) as { n: number };
    return row.n > 0;
  } catch (err) {
    // Table doesn't exist yet (e.g. migration not run in test env) — treat as empty.
    if (err instanceof Error && err.message.includes("no such table")) {
      return false;
    }
    throw err;
  }
}
