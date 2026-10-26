import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { repairCanonicalSqliteIndexes } from "../infra/sqlite-index-schema.js";
import { readSqliteNumberPragma } from "../infra/sqlite-pragma.test-support.js";
import { sqliteSchemaFixture } from "../infra/sqlite-schema-contract.test-support.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { VERSION } from "../version.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);
it("upgrades the plugin listing index through runtime without rewriting entries", async () => {
  const index = "idx_plugin_state_listing";
  const oldColumns = "plugin_id, namespace, created_at, entry_key";
  const insertSql = `INSERT INTO plugin_state_entries VALUES
        ('plugin', 'written', 'live', '{ "value": 1 }', 10, NULL),
        ('plugin', 'written', 'at-cutoff', '{ "value": 2 }', 10, 1000),
        ('plugin', 'sibling', 'expired', '{ "value": 3 }', 20, 999),
        ('plugin', 'sibling', 'future', '{ "value": 4 }', 20, 1001),
        ('peer', 'written', 'live', '{ "value": 5 }', 10, NULL)`;
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-index-repair-") } };
  const templatePath = openOpenClawStateDatabase({
    env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-index-template-") },
  }).path;
  await closeOpenClawStateDatabaseAsync();
  const databasePath = resolveOpenClawStateSqlitePath(options.env);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.copyFileSync(templatePath, databasePath);
  const entriesSql = "SELECT * FROM plugin_state_entries ORDER BY plugin_id, namespace, entry_key";
  const oldIndexSql = `CREATE INDEX ${index} ON plugin_state_entries(${oldColumns});`;
  const oldSchema = OPENCLAW_STATE_SCHEMA_SQL.replace(
    new RegExp(`CREATE INDEX IF NOT EXISTS ${index}\\s[^;]+;`, "u"),
    oldIndexSql,
  );
  const metadataSql =
    "SELECT role, agent_id, schema_version, app_version FROM schema_meta WHERE meta_key = 'primary'";
  let entries: unknown;
  let metadata: unknown;
  {
    using legacy = new (requireNodeSqlite().DatabaseSync)(databasePath);
    legacy.exec(`DROP INDEX ${index}; ${oldIndexSql} ${insertSql};`);
    entries = legacy.prepare(entriesSql).all();
    metadata = legacy.prepare(metadataSql).get();
    expect(metadata).toMatchObject({
      schema_version: OPENCLAW_STATE_SCHEMA_VERSION,
      app_version: VERSION,
    });
  }

  const pragma = (database: OpenClawStateDatabase, name: "user_version" | "schema_version") =>
    readSqliteNumberPragma(requireNativeSqliteDatabase(database.db), name);
  const expectPreserved = (database: OpenClawStateDatabase) => {
    expect(database.db.prepare(entriesSql).all()).toEqual(entries);
    expect(database.db.prepare(metadataSql).get()).toEqual(metadata);
  };
  const columns = ({ db }: OpenClawStateDatabase) =>
    db
      .prepare(`PRAGMA index_info(${index})`)
      .all()
      .map((row) => row.name);

  const upgraded = openOpenClawStateDatabase(options);
  expect(columns(upgraded)).toEqual([...oldColumns.split(", "), "expires_at"]);
  expectPreserved(upgraded);
  expect(pragma(upgraded, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
  const schemaVersion = pragma(upgraded, "schema_version");
  await closeOpenClawStateDatabaseAsync();

  const reopened = openOpenClawStateDatabase(options);
  expect(pragma(reopened, "schema_version")).toBe(schemaVersion);
  expectPreserved(reopened);

  // An older same-version owner restores its own derived index on binary rollback.
  expect(
    repairCanonicalSqliteIndexes(
      requireNativeSqliteDatabase(reopened.db),
      reopened.path,
      sqliteSchemaFixture(oldSchema),
    ),
  ).toEqual([index]);
  expect(columns(reopened)).toEqual(oldColumns.split(", "));
  expectPreserved(reopened);
  expect(pragma(reopened, "user_version")).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
  expect(reopened.db.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
});
