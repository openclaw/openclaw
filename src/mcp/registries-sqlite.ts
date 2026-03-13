/**
 * SQLite adapter for MCP registries (replaces tools.mcp.registries in openclaw.json).
 */
import { getStateDb } from "../infra/state-db/connection.js";
import type { McpRegistryConfig } from "./types.js";

// ── Read ─────────────────────────────────────────────────────────────────────

export function loadMcpRegistriesFromDb(): McpRegistryConfig[] {
  const db = getStateDb();
  const rows = db
    .prepare(
      "SELECT id, name, url, description, auth_token_env, visibility, enabled FROM op1_mcp_registries ORDER BY name",
    )
    .all() as Array<{
    id: string;
    name: string;
    url: string;
    description: string | null;
    auth_token_env: string | null;
    visibility: string | null;
    enabled: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    url: r.url,
    description: r.description ?? undefined,
    auth_token_env: r.auth_token_env ?? undefined,
    visibility: r.visibility === "public" || r.visibility === "private" ? r.visibility : undefined,
    enabled: r.enabled !== 0,
  }));
}

// ── Write ────────────────────────────────────────────────────────────────────

export function saveMcpRegistryToDb(registry: McpRegistryConfig): void {
  const db = getStateDb();
  db.prepare(
    `INSERT INTO op1_mcp_registries (id, name, url, description, auth_token_env, visibility, enabled, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       url = excluded.url,
       description = excluded.description,
       auth_token_env = excluded.auth_token_env,
       visibility = excluded.visibility,
       enabled = excluded.enabled,
       updated_at = unixepoch()`,
  ).run(
    registry.id,
    registry.name,
    registry.url,
    registry.description ?? null,
    registry.auth_token_env ?? null,
    registry.visibility ?? null,
    registry.enabled !== false ? 1 : 0,
  );
}

export function deleteMcpRegistryFromDb(id: string): boolean {
  const db = getStateDb();
  const result = db.prepare("DELETE FROM op1_mcp_registries WHERE id = ?").run(id);
  return (result.changes as number) > 0;
}
