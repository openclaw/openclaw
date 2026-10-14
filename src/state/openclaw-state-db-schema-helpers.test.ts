import path from "node:path";
import { constants, DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { enableNodeSqliteKyselyStatementCache } from "../infra/kysely-sync-cache-state.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { admitSqliteSchema } from "../infra/sqlite-schema-facts.js";
import { tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("tableExists", () => {
  it.each([false, true])(
    "reuses only admitted statements with fresh table names (cache: %s)",
    (cacheEnabled) => {
      const database = new DatabaseSync(":memory:");
      try {
        database.exec("CREATE TABLE present (id INTEGER); CREATE VIEW projection AS SELECT 1;");
        if (cacheEnabled) {
          enableNodeSqliteKyselyStatementCache(database);
        }
        const prepare = vi.spyOn(database, "prepare");
        const cases = [
          ["present", true],
          ["absent", false],
          ["projection", false],
          ["present' OR 1=1 --", false],
        ] as const;
        for (let repeat = 0; repeat < 8; repeat += 1) {
          for (const [tableName, expected] of cases) {
            expect(tableExists(database, tableName)).toBe(expected);
          }
        }
        expect(prepare).toHaveBeenCalledTimes(cacheEnabled ? 2 : 32);
      } finally {
        database.close();
      }
    },
  );

  it("observes schema changes within the current WAL read snapshot", () => {
    const filename = path.join(tempDirs.make("openclaw-schema-probe-"), "state.sqlite");
    const reader = new DatabaseSync(filename);
    const writer = new DatabaseSync(filename);
    try {
      reader.exec("PRAGMA journal_mode=WAL");
      enableNodeSqliteKyselyStatementCache(reader);
      expect(tableExists(reader, "entries")).toBe(false);
      expect(tableExists(reader, "entries")).toBe(false);
      writer.exec("CREATE TABLE entries (id INTEGER)");
      expect(tableExists(reader, "entries")).toBe(true);

      reader.exec("BEGIN");
      expect(tableExists(reader, "entries")).toBe(true);
      writer.exec("DROP TABLE entries");
      expect(tableExists(reader, "entries")).toBe(true);
      reader.exec("COMMIT");
      expect(tableExists(reader, "entries")).toBe(false);

      reader.exec("BEGIN; CREATE TABLE entries (id INTEGER)");
      expect(tableExists(reader, "entries")).toBe(true);
      reader.exec("ROLLBACK");
      expect(tableExists(reader, "entries")).toBe(false);
    } finally {
      writer.close();
      reader.close();
    }
  });

  it.skipIf(typeof DatabaseSync.prototype.setAuthorizer !== "function")(
    "rechecks changing authorization after warming the schema probe",
    () => {
      const database = openNodeSqliteDatabase(":memory:");
      try {
        database.exec("CREATE TABLE entries (id INTEGER)");
        enableNodeSqliteKyselyStatementCache(database);
        admitSqliteSchema(database);
        for (let repeat = 0; repeat < 3; repeat += 1) {
          expect(tableExists(database, "entries")).toBe(true);
          expect(tableHasColumn(database, "entries", "id")).toBe(true);
        }
        let allow = false;
        database.setAuthorizer(() => (allow ? constants.SQLITE_OK : constants.SQLITE_DENY));
        expect(() => tableExists(database, "entries")).toThrow(/not authorized/iu);
        expect(() => tableHasColumn(database, "entries", "id")).toThrow(/not authorized/iu);
        allow = true;
        expect(tableExists(database, "entries")).toBe(true);
        expect(tableHasColumn(database, "entries", "id")).toBe(true);
        allow = false;
        expect(() => tableExists(database, "entries")).toThrow(/not authorized/iu);
        expect(() => tableHasColumn(database, "entries", "id")).toThrow(/not authorized/iu);
        database.setAuthorizer(null);
        expect(tableExists(database, "entries")).toBe(true);
        expect(tableHasColumn(database, "entries", "id")).toBe(true);
      } finally {
        database.close();
      }
    },
  );
});

describe("tableHasColumn", () => {
  it("reuses admitted columns without SQL and follows committed or rolled-back DDL", () => {
    using database = openNodeSqliteDatabase(":memory:");
    database.exec("CREATE TABLE entries (id INTEGER)");
    admitSqliteSchema(database);
    expect(tableHasColumn(database, "entries", "id")).toBe(true);
    const observation = observeSqliteReadSql(StatementSync.prototype);
    try {
      for (let repeat = 0; repeat < 3; repeat += 1) {
        expect(tableHasColumn(database, "entries", "id")).toBe(true);
        expect(tableHasColumn(database, "entries", "missing")).toBe(false);
        expect(tableHasColumn(database, "absent", "id")).toBe(false);
      }
      expect(observation.queries).toEqual([]);
      database.exec("ALTER TABLE entries ADD COLUMN title TEXT");
      expect(tableHasColumn(database, "entries", "title")).toBe(true);
      database.exec("BEGIN; ALTER TABLE entries ADD COLUMN pending TEXT");
      expect(tableHasColumn(database, "entries", "pending")).toBe(true);
      database.exec("ROLLBACK");
      expect(tableHasColumn(database, "entries", "pending")).toBe(false);
      expect(tableHasColumn(database, "entries", "title")).toBe(true);
    } finally {
      observation.restore();
    }
  });

  it("preserves native column visibility for generated columns, views, and virtual tables", () => {
    using database = openNodeSqliteDatabase(":memory:");
    database.exec(`
      CREATE TABLE generated (base TEXT, derived TEXT AS /* expression */ (upper(base)));
      CREATE VIEW projected AS SELECT base FROM generated;
      CREATE VIRTUAL TABLE search USING fts5(body);
    `);
    admitSqliteSchema(database);
    const observation = observeSqliteReadSql(StatementSync.prototype);
    try {
      expect(tableHasColumn(database, "generated", "base")).toBe(true);
      expect(tableHasColumn(database, "generated", "derived")).toBe(false);
      expect(tableHasColumn(database, "projected", "base")).toBe(true);
      expect(tableHasColumn(database, "search", "body")).toBe(true);
      expect(tableHasColumn(database, "search", "rank")).toBe(false);
      expect(observation.queries).toContain("PRAGMA table_info(generated)");
      expect(observation.queries).toContain("PRAGMA table_info(projected)");
      expect(observation.queries).toContain("PRAGMA table_info(search)");
    } finally {
      observation.restore();
    }
  });
});
