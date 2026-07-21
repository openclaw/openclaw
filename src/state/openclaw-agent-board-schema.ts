import type { DatabaseSync } from "node:sqlite";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.generated.js";

const BOARD_SCHEMA_START = "CREATE TABLE IF NOT EXISTS board_tabs (";
const BOARD_SCHEMA_END = "CREATE TABLE IF NOT EXISTS heartbeat_outcomes (";
const BOARD_WIDGETS_SCHEMA_START = "CREATE TABLE IF NOT EXISTS board_widgets (";
const BOARD_WIDGETS_SCHEMA_END = "CREATE INDEX IF NOT EXISTS idx_agent_board_widgets_tab_position";
const BOARD_WIDGETS_MIGRATION_TABLE = "board_widgets_plugin_kind_migration_new";
const PLUGIN_CONTENT_KIND_PATTERN =
  /content_kind\s+IN\s*\(\s*'html'\s*,\s*'mcp-app'\s*,\s*'plugin'\s*\)/iu;
const LEGACY_CONTENT_KIND_PATTERN = /content_kind\s+IN\s*\(\s*'html'\s*,\s*'mcp-app'\s*\)/iu;
const MCP_APP_PAYLOAD_PATTERN =
  /content_kind\s*=\s*'mcp-app'\s+AND\s+html\s+IS\s+NULL\s+AND\s+descriptor_json\s+IS\s+NOT\s+NULL\s+AND\s+view_generation\s+IS\s+NULL/iu;
const PLUGIN_PAYLOAD_PATTERN =
  /content_kind\s*=\s*'plugin'\s+AND\s+html\s+IS\s+NULL\s+AND\s+descriptor_json\s+IS\s+NOT\s+NULL\s+AND\s+view_generation\s+IS\s+NULL/iu;

function splitBoardSchema(sql: string): { board: string; withoutBoard: string } {
  const start = sql.indexOf(BOARD_SCHEMA_START);
  const end = sql.indexOf(BOARD_SCHEMA_END, start);
  if (start === -1 || end === -1) {
    throw new Error("OpenClaw agent board schema markers are missing from the canonical schema.");
  }
  return {
    board: sql.slice(start, end),
    withoutBoard: `${sql.slice(0, start)}${sql.slice(end)}`,
  };
}

const boardSchema = splitBoardSchema(OPENCLAW_AGENT_SCHEMA_SQL);

const OPENCLAW_AGENT_BOARD_SCHEMA_SQL = boardSchema.board;
export const OPENCLAW_AGENT_SCHEMA_WITHOUT_BOARD_SQL = boardSchema.withoutBoard;

function canonicalBoardWidgetsCreateSql(): string {
  const start = OPENCLAW_AGENT_BOARD_SCHEMA_SQL.indexOf(BOARD_WIDGETS_SCHEMA_START);
  const end = OPENCLAW_AGENT_BOARD_SCHEMA_SQL.indexOf(BOARD_WIDGETS_SCHEMA_END, start);
  if (start === -1 || end === -1) {
    throw new Error("OpenClaw agent board widget schema markers are missing.");
  }
  return OPENCLAW_AGENT_BOARD_SCHEMA_SQL.slice(start, end).trim();
}

/**
 * Repairs the unreleased v13 board table shape without advancing the agent DB version.
 * Delete this same-version bridge when the lazy board schema folds into the next natural bump.
 */
export function ensureOpenClawAgentBoardSchemaInTransaction(db: DatabaseSync): void {
  if (!db.isTransaction) {
    throw new Error("board schema ensure requires an active transaction");
  }
  db.exec(OPENCLAW_AGENT_BOARD_SCHEMA_SQL);
  const row = db
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'board_widgets'")
    .get() as { sql?: unknown } | undefined;
  if (typeof row?.sql !== "string") {
    throw new Error("OpenClaw agent board widget schema is missing after ensure.");
  }
  const hasMcpAppPayload = MCP_APP_PAYLOAD_PATTERN.test(row.sql);
  const hasPluginPayload = PLUGIN_PAYLOAD_PATTERN.test(row.sql);
  if (PLUGIN_CONTENT_KIND_PATTERN.test(row.sql) && hasMcpAppPayload && hasPluginPayload) {
    return;
  }
  if (!LEGACY_CONTENT_KIND_PATTERN.test(row.sql) || !hasMcpAppPayload || hasPluginPayload) {
    throw new Error(
      "OpenClaw agent board widget schema has an unsupported content-kind constraint.",
    );
  }
  const existingMigrationTable = db
    .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(BOARD_WIDGETS_MIGRATION_TABLE);
  if (existingMigrationTable) {
    throw new Error(
      `OpenClaw agent board migration table already exists: ${BOARD_WIDGETS_MIGRATION_TABLE}`,
    );
  }
  const migrationCreateSql = canonicalBoardWidgetsCreateSql().replace(
    BOARD_WIDGETS_SCHEMA_START,
    `CREATE TABLE ${BOARD_WIDGETS_MIGRATION_TABLE} (`,
  );
  db.exec(`
    ${migrationCreateSql}
    INSERT INTO ${BOARD_WIDGETS_MIGRATION_TABLE} (
      session_key, name, tab_id, title, content_kind, html, descriptor_json, sha256,
      view_generation, revision, size_w, size_h, position, manifest, grant_state,
      granted_sha, created_by, created_at, updated_at
    )
    SELECT
      session_key, name, tab_id, title, content_kind, html, descriptor_json, sha256,
      view_generation, revision, size_w, size_h, position, manifest, grant_state,
      granted_sha, created_by, created_at, updated_at
    FROM board_widgets;
    DROP TABLE board_widgets;
    ALTER TABLE ${BOARD_WIDGETS_MIGRATION_TABLE} RENAME TO board_widgets;
  `);
  db.exec(OPENCLAW_AGENT_BOARD_SCHEMA_SQL);
}
