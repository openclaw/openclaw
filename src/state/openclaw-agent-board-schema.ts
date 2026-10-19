import { isPostgresSqlConnection, type EngineConnection } from "../infra/sql-connection.js";
import { createSqliteSchemaEnsurer } from "../infra/sqlite-schema-ensure.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { OPENCLAW_AGENT_BOARD_SCHEMA_SQL } from "./openclaw-agent-schema-history.js";

export { AGENT_V14_BOARD_SCHEMA_SQL } from "./openclaw-agent-schema-history.js";

const BOARD_WIDGETS_SCHEMA_START = "CREATE TABLE IF NOT EXISTS board_widgets (";
const BOARD_WIDGETS_MIGRATION_TABLE = "board_widgets_plugin_kind_migration_new";
const PLUGIN_CONTENT_KIND_CLAUSE_PATTERN =
  /content_kind\s+IN\s*\(\s*'html'\s*,\s*'mcp-app'\s*,\s*'plugin'\s*\)/iu;
const PLUGIN_PAYLOAD_BRANCH_PATTERN =
  /\s+OR\s+\(content_kind\s*=\s*'plugin'\s+AND\s+html\s+IS\s+NULL\s+AND\s+descriptor_json\s+IS\s+NOT\s+NULL\s+AND\s+view_generation\s+IS\s+NULL\)/iu;

const ensureBoardTables = createSqliteSchemaEnsurer(() => OPENCLAW_AGENT_BOARD_SCHEMA_SQL, {
  tables: ["board_tabs", "board_widgets"],
  indexes: ["idx_agent_board_widgets_tab_position"],
});

function canonicalBoardWidgetsCreateSql(): string {
  return extractSqliteTableSchema(OPENCLAW_AGENT_BOARD_SCHEMA_SQL, "board_widgets", {
    endMarker: "CREATE INDEX IF NOT EXISTS idx_agent_board_widgets_tab_position",
    includeEndMarker: false,
    errorMessage: "OpenClaw agent board widget schema markers are missing.",
  }).trim();
}

function legacyBoardWidgetsCreateSql(): string {
  const canonical = canonicalBoardWidgetsCreateSql();
  const legacy = canonical
    .replace(PLUGIN_CONTENT_KIND_CLAUSE_PATTERN, "content_kind IN ('html', 'mcp-app')")
    .replace(PLUGIN_PAYLOAD_BRANCH_PATTERN, "");
  if (legacy === canonical) {
    throw new Error("OpenClaw agent board widget legacy schema derivation failed.");
  }
  return legacy;
}

function normalizeBoardWidgetsCreateSql(sql: string): string {
  return sql
    .replace(
      /^CREATE TABLE(?: IF NOT EXISTS)?\s+(?:board_widgets|"board_widgets"|`board_widgets`|\[board_widgets\])\s*\(/iu,
      "CREATE TABLE board_widgets (",
    )
    .replace(/\s+/gu, " ")
    .replace(/;\s*$/u, "")
    .trim();
}

/** Repair the v14 board constraint inside the caller's schema/write transaction. */
export function ensureOpenClawAgentBoardSchemaInTransaction(db: EngineConnection): void {
  if (!db.isTransaction) {
    throw new Error("board schema ensure requires an active transaction");
  }
  if (isPostgresSqlConnection(db)) {
    return;
  }
  ensureBoardTables(db);
  const sql =
    getAdmittedSqliteSchemaFacts(db)?.tableSql.get("board_widgets") ??
    db // sqlite-allow-raw -- Unadmitted maintenance handles inspect the bounded same-version migration.
      .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'board_widgets'")
      .get()?.sql;
  if (typeof sql !== "string") {
    throw new Error("OpenClaw agent board widget schema is missing after ensure.");
  }
  const normalizedSchema = normalizeBoardWidgetsCreateSql(sql);
  if (normalizedSchema === normalizeBoardWidgetsCreateSql(canonicalBoardWidgetsCreateSql())) {
    return;
  }
  if (normalizedSchema !== normalizeBoardWidgetsCreateSql(legacyBoardWidgetsCreateSql())) {
    throw new Error(
      "OpenClaw agent board widget schema has an unsupported content-kind constraint.",
    );
  }
  const existingMigrationTable = db // sqlite-allow-raw -- Fail closed if an abandoned migration table exists.
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
  db.exec(/* sqlite-allow-raw -- Rebuild one unreleased table constraint inside the caller's transaction. */ `
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
  db.exec(OPENCLAW_AGENT_BOARD_SCHEMA_SQL); // sqlite-allow-raw -- Restore the canonical board index after the rebuild.
}
