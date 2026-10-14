// Same-version index repairs preserve canonical rows across upgrade and rollback.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { repairCanonicalSqliteIndexes } from "../infra/sqlite-index-schema.js";
import { readSqliteNumberPragma } from "../infra/sqlite-pragma.test-support.js";
import { VERSION } from "../version.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);
let templatePath: string;

beforeAll(async () => {
  templatePath = openOpenClawStateDatabase({
    env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-index-template-") },
  }).path;
  await closeOpenClawStateDatabaseAsync();
});

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
});

describe("shared-state canonical index repair", () => {
  it.each([
    {
      name: "plugin listing",
      index: "idx_plugin_state_listing",
      table: "plugin_state_entries",
      oldColumns: "plugin_id, namespace, created_at, entry_key",
      columns: ["plugin_id", "namespace", "created_at", "entry_key", "expires_at"],
      order: "plugin_id, namespace, entry_key",
      insertSql: `INSERT INTO plugin_state_entries VALUES
        ('plugin', 'written', 'live', '{ "value": 1 }', 10, NULL),
        ('plugin', 'written', 'at-cutoff', '{ "value": 2 }', 10, 1000),
        ('plugin', 'sibling', 'expired', '{ "value": 3 }', 20, 999),
        ('plugin', 'sibling', 'future', '{ "value": 4 }', 20, 1001),
        ('peer', 'written', 'live', '{ "value": 5 }', 10, NULL)`,
    },
  ])(
    "upgrades the $name index through runtime without rewriting entries",
    async ({ index, table, oldColumns, columns, order, insertSql }) => {
      const stateDir = tempDirs.make("openclaw-index-repair-");
      const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
      const databasePath = resolveOpenClawStateSqlitePath(options.env);
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      fs.copyFileSync(templatePath, databasePath);
      const { DatabaseSync } = requireNodeSqlite();
      const legacy = new DatabaseSync(databasePath);
      const entriesSql = `SELECT * FROM ${table} ORDER BY ${order}`;
      const oldIndexSql = `CREATE INDEX ${index} ON ${table}(${oldColumns});`;
      const oldSchema = OPENCLAW_STATE_SCHEMA_SQL.replace(
        new RegExp(`CREATE INDEX IF NOT EXISTS ${index}\\s[^;]+;`, "u"),
        oldIndexSql,
      );
      const metadataSql =
        "SELECT role, agent_id, schema_version, app_version FROM schema_meta WHERE meta_key = 'primary'";
      let entries: unknown;
      let metadata: unknown;
      try {
        legacy.exec(`DROP INDEX ${index}; ${oldIndexSql} ${insertSql};`);
        entries = legacy.prepare(entriesSql).all();
        metadata = legacy.prepare(metadataSql).get();
        expect(metadata).toMatchObject({
          schema_version: OPENCLAW_STATE_SCHEMA_VERSION,
          app_version: VERSION,
        });
      } finally {
        legacy.close();
      }

      const upgraded = openOpenClawStateDatabase(options);
      expect(
        upgraded.db
          .prepare(`PRAGMA index_info(${index})`)
          .all()
          .map((row) => row.name),
      ).toEqual(columns);
      expect(upgraded.db.prepare(entriesSql).all()).toEqual(entries);
      expect(upgraded.db.prepare(metadataSql).get()).toEqual(metadata);
      expect(readSqliteNumberPragma(upgraded.db, "user_version")).toBe(
        OPENCLAW_STATE_SCHEMA_VERSION,
      );
      const schemaVersion = readSqliteNumberPragma(upgraded.db, "schema_version");
      await closeOpenClawStateDatabaseAsync();

      const reopened = openOpenClawStateDatabase(options);
      expect(readSqliteNumberPragma(reopened.db, "schema_version")).toBe(schemaVersion);
      expect(reopened.db.prepare(entriesSql).all()).toEqual(entries);
      expect(reopened.db.prepare(metadataSql).get()).toEqual(metadata);

      // An older same-version owner restores its own derived index on binary rollback.
      expect(repairCanonicalSqliteIndexes(reopened.db, reopened.path, oldSchema)).toEqual([index]);
      expect(
        reopened.db
          .prepare(`PRAGMA index_info(${index})`)
          .all()
          .map((row) => row.name),
      ).toEqual(oldColumns.split(", "));
      expect(reopened.db.prepare(entriesSql).all()).toEqual(entries);
      expect(reopened.db.prepare(metadataSql).get()).toEqual(metadata);
      expect(readSqliteNumberPragma(reopened.db, "user_version")).toBe(
        OPENCLAW_STATE_SCHEMA_VERSION,
      );
      expect(reopened.db.prepare("PRAGMA integrity_check").all()).toEqual([
        { integrity_check: "ok" },
      ]);
    },
  );
});
