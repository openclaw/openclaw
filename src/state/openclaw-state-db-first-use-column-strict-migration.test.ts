import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { CLAW_FIRST_USE_ADDITIVE_STATE_COLUMN_DEFINITIONS as FIRST_USE_COLUMNS } from "./openclaw-state-db-additive-columns.js";
import { OPENCLAW_STATE_SCHEMA_VERSION as SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { expectRow, expectRows, readRows } from "./openclaw-state-db-fixtures.test-support.js";
import {
  closeOpenClawStateDatabaseForTest as closeState,
  openOpenClawStateDatabase as openState,
  repairOpenClawStateDatabaseSchema as repairSchema,
} from "./openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL as SCHEMA_SQL } from "./openclaw-state-schema.js";
import {
  addPreCutoverClientCredentialTablesForTest,
  withStateMigrationBackupForTest,
} from "./openclaw-state-schema.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(closeState);

function legacyFixture(tableName: string) {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("state-first-use-") } };
  const databasePath = openState(options).path;
  closeState();
  const { DatabaseSync } = requireNodeSqlite();
  using legacy = new DatabaseSync(databasePath);
  const version = tableName === "user_profile_identities" ? 6 : 2;
  addPreCutoverClientCredentialTablesForTest(legacy);
  legacy.exec(`
    DROP INDEX idx_worker_session_placements_environment;
    ${
      tableName === "user_profile_identities"
        ? `
      CREATE TABLE user_profiles (id TEXT NOT NULL PRIMARY KEY, display_name TEXT,
        avatar BLOB, avatar_mime TEXT, avatar_sha256 TEXT, merged_into TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
      CREATE TABLE user_profile_emails (email TEXT NOT NULL PRIMARY KEY,
        profile_id TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
      CREATE TABLE user_profile_identities (provider TEXT NOT NULL, subject TEXT NOT NULL,
        profile_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (provider, subject)) STRICT;
      INSERT INTO user_profiles (id, display_name, created_at, updated_at)
        VALUES ('profile', 'Synthetic', 1, 1);
      INSERT INTO user_profile_emails VALUES ('synthetic@example.invalid', 'profile', 1);
      INSERT INTO user_profile_identities VALUES ('tailscale', 'subject', 'profile', 1);
    `
        : tableName === "device_bootstrap_tokens"
          ? `
      DROP TABLE device_bootstrap_tokens;
      CREATE TABLE device_bootstrap_tokens (
        token_key TEXT NOT NULL PRIMARY KEY, token TEXT NOT NULL, ts INTEGER NOT NULL,
        device_id TEXT, public_key TEXT, profile_json TEXT, redeemed_profile_json TEXT,
        pending_profile_json TEXT, issued_at_ms INTEGER NOT NULL, last_used_at_ms INTEGER
      );
      INSERT INTO device_bootstrap_tokens (token_key, token, ts, issued_at_ms)
        VALUES ('bootstrap', 'retained-token', 1000, 1000);
    `
          : `
      DROP TABLE session_groups;
      CREATE TABLE session_groups (name TEXT NOT NULL PRIMARY KEY,
        position INTEGER NOT NULL, created_at INTEGER NOT NULL);
    `
    }
    PRAGMA user_version = ${version};
    UPDATE schema_meta SET schema_version = ${version} WHERE meta_key = 'primary';
  `);
  const retained =
    tableName === "user_profile_identities"
      ? ["user_profiles", "user_profile_emails", tableName].map((table) => ({
          table,
          rows: readRows(legacy, `SELECT * FROM ${table}`),
        }))
      : [];
  return { options, retained };
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

it("creates STRICT tables that reject incompatible storage types", () => {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-state-fresh-strict-") } };
  const { db } = openState(options);
  expectRows(
    db,
    "SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%' AND strict = 0",
    [],
  );
  db.prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)").run("proof", "1", 1);
  expect(() =>
    db
      .prepare("UPDATE config_machine_state SET value_json = ? WHERE state_key = ?")
      .run(Buffer.from("invalid-text"), "proof"),
  ).toThrow(/BLOB.*TEXT/iu);
});

it.each([
  { tableName: "device_bootstrap_tokens", doctor: true },
  { tableName: "session_groups", doctor: true },
  { tableName: "device_bootstrap_tokens", doctor: false },
  { tableName: "user_profile_identities", doctor: true },
])("migrates legacy $tableName (doctor: $doctor)", async ({ tableName, doctor }) => {
  const bootstrap = tableName === "device_bootstrap_tokens";
  const { options, retained } = legacyFixture(tableName);
  const columnNames = bootstrap
    ? ["setup_id"]
    : tableName === "session_groups"
      ? ["cwd", "worktree"]
      : ["canonical_login"];
  // Regression: STRICT rebuild rolled back and reported an unrelated audit migration.
  if (!doctor) {
    expect(() => openState(options)).toThrow(/backed-up migration custody/);
  }
  await withStateMigrationBackupForTest(options, () => {
    if (doctor) {
      expect(repairSchema(options).warnings).toEqual([]);
    }
    openState(options);
  });
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
  for (const { table, rows } of retained) {
    expect(readRows(db, `SELECT * FROM ${table}`)).toMatchObject(rows);
  }
  if (retained.length > 0) {
    expectRow(db, "SELECT canonical_login FROM user_profile_identities", { canonical_login: null });
    expectRows(db, "PRAGMA integrity_check", [{ integrity_check: "ok" }]);
  }
});
