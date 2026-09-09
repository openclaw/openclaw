// Covers doctor repair and writable cold open for databases missing first-use
// additive columns while the STRICT migration rebuilds their tables.
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { migrateDoctorSessionGroups } from "../commands/doctor-session-groups.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { StartupMaintenanceRequiredError } from "../infra/startup-maintenance-required.js";
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
  it("repairs device_bootstrap_tokens without setup_id while migrating to STRICT", async () => {
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

    expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([
      expect.stringContaining("run openclaw doctor --fix"),
    ]);
    await migrateDoctorSessionGroups({}, options.env);

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

  it("requires Doctor before a writable cold open of the pre-STRICT store", async () => {
    const stateDir = tempDirs.make("openclaw-state-first-use-cold-open-");
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    makePreStrictDatabaseWithoutColumns({
      stateDir,
      tableName: "device_bootstrap_tokens",
      indexNames: ["idx_device_bootstrap_tokens_ts"],
      columnNames: ["setup_id"],
    });

    expect(() => openOpenClawStateDatabase(options)).toThrow(StartupMaintenanceRequiredError);
    await migrateDoctorSessionGroups({}, options.env);
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
  });
});
