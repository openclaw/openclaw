import { afterEach, expect, it } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { CLAW_FIRST_USE_ADDITIVE_STATE_COLUMN_DEFINITIONS as FIRST_USE_COLUMNS } from "./openclaw-state-db-additive-columns.js";
import { OPENCLAW_STATE_SCHEMA_VERSION as SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  expectRow,
  expectRows,
  readRow,
  readRows,
} from "./openclaw-state-db-fixtures.test-support.js";
import {
  closeOpenClawStateDatabaseForTest as closeState,
  openOpenClawStateDatabase as openState,
  repairOpenClawStateDatabaseSchema as repairSchema,
} from "./openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL as SCHEMA_SQL } from "./openclaw-state-schema.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(closeState);

// Rebuild a pre-STRICT table missing first-use columns, at schema version 2.
function makePreStrictDatabaseWithoutColumns(params: {
  stateDir: string;
  tableName: string;
  indexNames: readonly string[];
  columnNames: readonly string[];
  seed?: (database: InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>) => void;
}) {
  const options = { env: { OPENCLAW_STATE_DIR: params.stateDir } };
  const databasePath = openState(options).path;
  closeState();

  const { DatabaseSync } = requireNodeSqlite();
  using legacy = new DatabaseSync(databasePath);
  const strictCreateSql = (
    readRow(
      legacy,
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
      params.tableName,
    ) as { sql: string }
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
}

// Existing rows require bare nullable columns: constraints/defaults could rewrite or reject them.
it.each(FIRST_USE_COLUMNS)(
  "keeps $tableName.$columnName bare and nullable in the canonical schema",
  ({ columnName, dataType, tableName }) => {
    const tableStart = SCHEMA_SQL.indexOf(`CREATE TABLE IF NOT EXISTS ${tableName} (`);
    expect(tableStart).toBeGreaterThanOrEqual(0);
    const tableBody = SCHEMA_SQL.slice(tableStart, SCHEMA_SQL.indexOf(") STRICT;", tableStart));
    const declaration = tableBody
      .split("\n")
      .find((line) => new RegExp(`^\\s*${columnName}\\s`, "u").test(line))
      ?.trim()
      .replace(/,$/u, "");
    expect(declaration).toBe(`${columnName} ${dataType}`);
  },
);

it("opens fresh STRICT tables without legacy rebuild inspection and preserves later writes", () => {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-state-fresh-strict-") } };
  const reads = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
  try {
    const { db } = openState(options);
    // Rebuild planning inspects every canonical column twice, even with no legacy rows.
    expect(reads.queries.filter((sql) => /^PRAGMA table_xinfo\b/iu.test(sql))).toEqual([]);
    expectRows(
      db,
      "SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%' AND strict = 0",
      [],
    );
    db.prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)").run("bootstrap-proof", "1", 1);
    db.prepare(
      "UPDATE config_machine_state SET value_json = ?, updated_at_ms = ? WHERE state_key = ?",
    ).run("2", 2, "bootstrap-proof");
    closeState();
    const reopened = openState(options);
    expectRow(
      reopened.db,
      "SELECT value_json, updated_at_ms FROM config_machine_state WHERE state_key = ?",
      { value_json: "2", updated_at_ms: 2 },
      "bootstrap-proof",
    );
    expect(() =>
      reopened.db
        .prepare("UPDATE config_machine_state SET value_json = ? WHERE state_key = ?")
        .run(Buffer.from("invalid-text"), "bootstrap-proof"),
    ).toThrow(/BLOB.*TEXT/iu);
  } finally {
    reads.restore();
  }
});

it.each([
  { tableName: "device_bootstrap_tokens", doctor: true },
  { tableName: "session_groups", doctor: true },
  { tableName: "device_bootstrap_tokens", doctor: false },
])("migrates $tableName to STRICT (doctor: $doctor)", ({ tableName, doctor }) => {
  const stateDir = tempDirs.make("openclaw-state-first-use-");
  const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
  const bootstrap = tableName === "device_bootstrap_tokens";
  const columnNames = bootstrap ? ["setup_id"] : ["cwd", "worktree"];
  makePreStrictDatabaseWithoutColumns({
    stateDir,
    tableName,
    columnNames,
    indexNames: bootstrap ? ["idx_device_bootstrap_tokens_ts"] : [],
    seed: bootstrap
      ? (db) => {
          db.prepare(
            "INSERT INTO device_bootstrap_tokens (token_key, token, ts, issued_at_ms) VALUES (?, ?, ?, ?)",
          ).run("bootstrap", "retained-token", 1_000, 1_000);
        }
      : undefined,
  });
  // Regression: STRICT rebuild rolled back and reported an unrelated audit migration.
  if (doctor) {
    expect(repairSchema(options).warnings).toEqual([]);
  }
  const { db } = openState(options);
  expectRow(db, "PRAGMA user_version", { user_version: SCHEMA_VERSION });
  expectRow(db, "SELECT strict FROM pragma_table_list WHERE name = ?", { strict: 1 }, tableName);
  const columns = readRows(db, "SELECT name FROM pragma_table_info(?)", tableName).map(
    (row) => row.name,
  );
  for (const column of columnNames) {
    expect(columns).toContain(column);
  }
  if (bootstrap) {
    expectRows(db, "SELECT token_key, token, setup_id FROM device_bootstrap_tokens", [
      { token_key: "bootstrap", token: "retained-token", setup_id: null },
    ]);
  }
});
