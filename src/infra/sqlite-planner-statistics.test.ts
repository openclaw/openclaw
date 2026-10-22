import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as nodeSqlite from "./node-sqlite.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { refreshSqlitePlannerStatistics } from "./sqlite-planner-statistics.js";

afterEach(() => vi.restoreAllMocks());

describe("SQLite planner maintenance", () => {
  it("refreshes statistics with bounded analysis on the supported SQLite 3.44 line", () => {
    using database = openNodeSqliteDatabase(":memory:");
    const admission = nodeSqlite.captureSqliteNativeRuntimeAdmission();
    assert(admission);
    vi.spyOn(nodeSqlite, "captureSqliteNativeRuntimeAdmission").mockReturnValue({
      ...admission,
      version: "3.44.6",
    });
    database.exec(`
      CREATE TABLE samples (value INTEGER NOT NULL);
      CREATE INDEX samples_value ON samples(value);
      WITH RECURSIVE n(value) AS (VALUES(1) UNION ALL SELECT value + 1 FROM n WHERE value < 32)
      INSERT INTO samples SELECT value FROM n;
      ANALYZE main;
      UPDATE sqlite_stat1 SET stat = '40 1';
      ANALYZE sqlite_schema;
    `);

    refreshSqlitePlannerStatistics(database);

    expect(
      database.prepare("SELECT stat FROM sqlite_stat1 WHERE idx = 'samples_value'").get(),
    ).toEqual({ stat: "32 1" });
    expect(database.prepare("PRAGMA analysis_limit").get()?.analysis_limit).toBe(1000);
  });

  it("fills missing statistics, preserves usable estimates, and refreshes stale estimates", () => {
    using database = openNodeSqliteDatabase(":memory:");
    database.exec(`
      CREATE TABLE samples (value INTEGER NOT NULL);
      CREATE INDEX samples_value ON samples(value);
      WITH RECURSIVE n(value) AS (VALUES(1) UNION ALL SELECT value + 1 FROM n WHERE value < 32)
      INSERT INTO samples SELECT value FROM n;
    `);
    const readStatistics = () =>
      database.prepare("SELECT stat FROM sqlite_stat1 WHERE idx = 'samples_value'").get()?.stat;

    refreshSqlitePlannerStatistics(database);
    expect(readStatistics()).toBe("32 1");
    expect(database.prepare("PRAGMA analysis_limit").get()?.analysis_limit).toBe(1000);

    // A usable estimate need not be exact. Unconditional ANALYZE would replace it.
    database.exec("UPDATE sqlite_stat1 SET stat = '40 1'; ANALYZE sqlite_schema;");
    refreshSqlitePlannerStatistics(database);
    expect(readStatistics()).toBe("40 1");

    database.exec(`
      WITH RECURSIVE n(value) AS (VALUES(33) UNION ALL SELECT value + 1 FROM n WHERE value < 1024)
      INSERT INTO samples SELECT value FROM n;
    `);
    refreshSqlitePlannerStatistics(database);
    expect(readStatistics()).not.toBe("40 1");
  });
});
