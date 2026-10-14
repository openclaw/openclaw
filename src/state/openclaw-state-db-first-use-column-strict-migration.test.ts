// Covers doctor repair and writable cold open for databases missing first-use
// additive columns while the STRICT migration rebuilds their tables.
import { afterEach, describe, expect, it } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { CLAW_FIRST_USE_ADDITIVE_STATE_COLUMN_DEFINITIONS } from "./openclaw-state-db-additive-columns.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

/**
 * Rebuild one canonical table as a pre-STRICT database that never gained the
 * given first-use columns, then drop the whole database to schema version 2.
 */
function makePreStrictDatabaseWithoutColumns(params: {
  stateDir: string;
  tableName: string;
  indexNames: readonly string[];
  columnNames: readonly string[];
  seed?: (database: InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>) => void;
}): string {
  const options = { env: { OPENCLAW_STATE_DIR: params.stateDir } };
  const databasePath = openOpenClawStateDatabase(options).path;
  closeOpenClawStateDatabaseForTest();

  const { DatabaseSync } = requireNodeSqlite();
  const legacy = new DatabaseSync(databasePath);
  const strictCreateSql = (
    legacy
      .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get(params.tableName) as { sql: string }
  ).sql;
  const dropped = new Set(params.columnNames);
  const lines = strictCreateSql.replace(/\s+STRICT$/u, "").split("\n");
  const kept = lines.filter((line) => {
    const columnName = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s/u.exec(line)?.[1];
    return !(columnName && dropped.has(columnName));
  });
  // The removed column may have been last, so re-fix the trailing separator.
  const legacyCreateSql = kept
    .join("\n")
    .replace(/,(\s*\n\s*\))/u, "$1")
    .replace(/([^,(\s])(\s*\n\s*[A-Za-z_][A-Za-z0-9_]*\s+[A-Z])/u, "$1,$2");
  for (const columnName of params.columnNames) {
    expect(legacyCreateSql).not.toContain(columnName);
  }
  expect(legacyCreateSql).not.toBe(strictCreateSql);

  const dropIndexes = params.indexNames.map((name) => `DROP INDEX ${name};`).join("\n");
  // The synthetic pre-STRICT database predates this placement index.
  legacy.exec("DROP INDEX idx_worker_session_placements_environment;");
  legacy.exec(`
    ${dropIndexes}
    ALTER TABLE ${params.tableName} RENAME TO ${params.tableName}_strict;
    ${legacyCreateSql};
    DROP TABLE ${params.tableName}_strict;
    PRAGMA user_version = 2;
    UPDATE schema_meta SET schema_version = 2 WHERE meta_key = 'primary';
  `);
  params.seed?.(legacy);
  legacy.close();
  return databasePath;
}

describe("first-use additive column definitions", () => {
  // Materializing these columns early is only safe while every one of them is
  // bare and nullable: the pre-STRICT rebuild adds them to tables that already
  // hold rows, so anything NOT NULL, defaulted, constrained, or key-bearing
  // would fail or silently rewrite existing data. Enforce that here rather than
  // leaving it to the convention documented on the definition list.
  it.each(
    CLAW_FIRST_USE_ADDITIVE_STATE_COLUMN_DEFINITIONS.map((definition) => [
      `${definition.tableName}.${definition.columnName}`,
      definition,
    ]),
  )("keeps %s bare and nullable in the canonical schema", (_label, definition) => {
    const { columnName, dataType, tableName } = definition as {
      columnName: string;
      dataType: string;
      tableName: string;
    };
    const tableStart = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
      `CREATE TABLE IF NOT EXISTS ${tableName} (`,
    );
    expect(tableStart).toBeGreaterThanOrEqual(0);
    const tableBody = OPENCLAW_STATE_SCHEMA_SQL.slice(
      tableStart,
      OPENCLAW_STATE_SCHEMA_SQL.indexOf(") STRICT;", tableStart),
    );
    const declaration = tableBody
      .split("\n")
      .find((line) => new RegExp(`^\\s*${columnName}\\s`, "u").test(line))
      ?.trim()
      .replace(/,$/u, "");
    expect(declaration).toBe(`${columnName} ${dataType}`);
  });
});

describe("first-use additive column STRICT migration", () => {
  it("opens fresh STRICT tables without legacy rebuild inspection and preserves later writes", () => {
    const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-state-fresh-strict-") } };
    const reads = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
    try {
      const { db } = openOpenClawStateDatabase(options);
      // Rebuild planning inspects every canonical column twice, even with no legacy rows.
      expect(reads.queries.filter((sql) => /^PRAGMA table_xinfo\b/iu.test(sql))).toEqual([]);
      expect(
        db
          .prepare(
            "SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%' AND strict = 0",
          )
          .all(),
      ).toEqual([]);
      db.prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)").run(
        "bootstrap-proof",
        "1",
        1,
      );
      db.prepare(
        "UPDATE config_machine_state SET value_json = ?, updated_at_ms = ? WHERE state_key = ?",
      ).run("2", 2, "bootstrap-proof");
      closeOpenClawStateDatabaseForTest();
      const reopened = openOpenClawStateDatabase(options);
      expect(
        reopened.db
          .prepare("SELECT value_json, updated_at_ms FROM config_machine_state WHERE state_key = ?")
          .get("bootstrap-proof"),
      ).toEqual({ value_json: "2", updated_at_ms: 2 });
      expect(() =>
        reopened.db
          .prepare("UPDATE config_machine_state SET value_json = ? WHERE state_key = ?")
          .run(Buffer.from("invalid-text"), "bootstrap-proof"),
      ).toThrow(/BLOB.*TEXT/iu);
    } finally {
      reads.restore();
    }
  });

  it("repairs device_bootstrap_tokens without setup_id while migrating to STRICT", () => {
    const stateDir = tempDirs.make("openclaw-state-first-use-column-");
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    makePreStrictDatabaseWithoutColumns({
      stateDir,
      tableName: "device_bootstrap_tokens",
      indexNames: ["idx_device_bootstrap_tokens_ts"],
      columnNames: ["setup_id"],
      seed: (database) => {
        database
          .prepare(
            `INSERT INTO device_bootstrap_tokens (token_key, token, ts, issued_at_ms)
             VALUES (?, ?, ?, ?)`,
          )
          .run("bootstrap", "token-value", 1_000, 1_000);
      },
    });

    // Before the fix this returns a warning and applies nothing, which leaves the
    // whole repair rolled back and re-reports an unrelated audit-events migration.
    expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);

    const migrated = openOpenClawStateDatabase(options);
    expect(migrated.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    expect(
      migrated.db
        .prepare("SELECT strict FROM pragma_table_list WHERE name = 'device_bootstrap_tokens'")
        .get(),
    ).toEqual({ strict: 1 });
    // The rebuilt table comes from canonical SQL, so the column exists afterwards
    // and the pre-existing row survives with a NULL correlation id.
    expect(
      migrated.db.prepare("SELECT token_key, token, setup_id FROM device_bootstrap_tokens").all(),
    ).toEqual([{ token_key: "bootstrap", token: "token-value", setup_id: null }]);
  });

  it("repairs session_groups without the folder default columns", () => {
    const stateDir = tempDirs.make("openclaw-state-first-use-group-");
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    makePreStrictDatabaseWithoutColumns({
      stateDir,
      tableName: "session_groups",
      indexNames: [],
      columnNames: ["cwd", "worktree"],
    });

    expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);

    const migrated = openOpenClawStateDatabase(options);
    expect(migrated.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    expect(
      migrated.db
        .prepare("SELECT strict FROM pragma_table_list WHERE name = 'session_groups'")
        .get(),
    ).toEqual({ strict: 1 });
    const columns = migrated.db
      .prepare("SELECT name FROM pragma_table_info('session_groups')")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(columns).toContain("cwd");
    expect(columns).toContain("worktree");
  });

  it("migrates on a writable cold open without a doctor repair", () => {
    const stateDir = tempDirs.make("openclaw-state-first-use-cold-open-");
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    makePreStrictDatabaseWithoutColumns({
      stateDir,
      tableName: "device_bootstrap_tokens",
      indexNames: ["idx_device_bootstrap_tokens_ts"],
      columnNames: ["setup_id"],
      seed: (database) => {
        database
          .prepare(
            "INSERT INTO device_bootstrap_tokens (token_key, token, ts, issued_at_ms) VALUES (?, ?, ?, ?)",
          )
          .run("bootstrap", "retained-token", 1_000, 1_000);
      },
    });

    // The gateway upgrades the same database on a normal writable open, so that
    // path has to clear the STRICT rebuild without doctor running first.
    const opened = openOpenClawStateDatabase(options);
    expect(opened.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    expect(
      opened.db
        .prepare("SELECT strict FROM pragma_table_list WHERE name = 'device_bootstrap_tokens'")
        .get(),
    ).toEqual({ strict: 1 });
    const columns = opened.db
      .prepare("SELECT name FROM pragma_table_info('device_bootstrap_tokens')")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(columns).toContain("setup_id");
    expect(
      opened.db.prepare("SELECT token_key, token, setup_id FROM device_bootstrap_tokens").all(),
    ).toEqual([{ token_key: "bootstrap", token: "retained-token", setup_id: null }]);
  });
});
