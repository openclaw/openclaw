import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../state/openclaw-agent-schema.js";
import * as nodeSqlite from "./node-sqlite.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import {
  refreshSqlitePlannerStatistics,
  sqlitePlannerStatisticsNeedRefresh,
} from "./sqlite-planner-statistics.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTempDirs(tempDirs);
});

const fill = (table: string, from: number, to: number) => `
  WITH RECURSIVE n(v) AS (VALUES(${from}) UNION ALL SELECT v + 1 FROM n WHERE v < ${to})
  INSERT INTO ${table} SELECT v, printf('%0200d', v) FROM n;`;

/** SQLite's own answer, from a writable copy: would optimize analyze a table that changes stat1? */
function sqliteWouldRefresh(pathname: string): boolean {
  const copy = `${pathname}.${Math.random().toString(36).slice(2)}.oracle`;
  fs.copyFileSync(pathname, copy);
  using database = openNodeSqliteDatabase(copy);
  const readStat = () => JSON.stringify(database.prepare("SELECT * FROM sqlite_stat1").all());
  const before = database.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_stat1'").get()
    ? readStat()
    : "[]";
  // Debug mode lists each ANALYZE without running it; a writable connection may hold a write.
  const planned = (
    database.prepare("PRAGMA optimize=0x10003").all() as Array<{ optimize: string }>
  ).map(({ optimize }) => /"main"\."(\w+)"$/u.exec(optimize)?.[1]);
  // Reanalyzing a table with rows rewrites its stat1 rows even when the values match.
  const reanalyzesRows = planned.some(
    (table) => table === undefined || Boolean(database.prepare(`SELECT 1 FROM "${table}"`).get()),
  );
  refreshSqlitePlannerStatistics(database);
  return reanalyzesRows || before !== readStat();
}

function readOnlyAnswer(pathname: string): boolean {
  using database = openNodeSqliteDatabase(pathname, { readOnly: true });
  return sqlitePlannerStatisticsNeedRefresh(database);
}

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

  it("answers read-only exactly when optimize would refresh statistics", () => {
    const pathname = path.join(makeTempDir(tempDirs, "openclaw-planner-"), "store.sqlite");
    const writer = openNodeSqliteDatabase(pathname);
    const observations: Array<{ step: string; readOnly: boolean; sqlite: boolean }> = [];
    const observe = (step: string, change: string) => {
      writer.exec(change);
      observations.push({
        step,
        readOnly: readOnlyAnswer(pathname),
        sqlite: sqliteWouldRefresh(pathname),
      });
    };
    observe(
      "never analyzed",
      `CREATE TABLE samples (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
       CREATE INDEX samples_value ON samples(value);
       CREATE TABLE plain (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
       CREATE TABLE idle (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
       CREATE INDEX idle_value ON idle(value);
       ${fill("samples", 1, 3000)} ${fill("plain", 1, 400)}`,
    );
    observe("refreshed", "PRAGMA analysis_limit=1000; PRAGMA optimize=0x10002;");
    observe("small growth", fill("samples", 3001, 4000));
    observe("tenfold growth", fill("samples", 4001, 60_000));
    observe("refreshed again", "PRAGMA analysis_limit=1000; PRAGMA optimize=0x10002;");
    observe("unindexed growth", fill("plain", 401, 20_000));
    observe("refreshed unindexed", "PRAGMA analysis_limit=1000; PRAGMA optimize=0x10002;");
    observe("leftmost rows deleted", "DELETE FROM samples WHERE id < 57000;");
    observe("refreshed after delete", "PRAGMA analysis_limit=1000; PRAGMA optimize=0x10002;");
    observe("emptied table with statistics", "DELETE FROM plain;");
    observe("refreshed empty", "PRAGMA analysis_limit=1000; PRAGMA optimize=0x10002;");
    // Two short-row leaves under a one-cell root: the estimate counts the root's two
    // children, so a recorded count of 15 sits just outside optimize's 10x band.
    observe(
      "small fanout near the threshold",
      `CREATE TABLE fan (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
       CREATE INDEX fan_value ON fan(value);
       WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v + 1 FROM n WHERE v < 220)
       INSERT INTO fan SELECT v, printf('%020d', v) FROM n;
       PRAGMA analysis_limit=1000; PRAGMA optimize=0x10002;
       UPDATE sqlite_stat1 SET stat = '15 1' WHERE tbl = 'fan';
       ANALYZE sqlite_schema;`,
    );
    writer.close();

    expect(observations.map(({ step, readOnly }) => ({ step, readOnly }))).toEqual(
      observations.map(({ step, sqlite }) => ({ step, readOnly: sqlite })),
    );
    expect(
      observations.find(({ step }) => step === "small fanout near the threshold"),
    ).toMatchObject({
      sqlite: true,
    });
    // The fixture reaches both answers, so agreement is not vacuous.
    expect(new Set(observations.map(({ sqlite }) => sqlite))).toEqual(new Set([true, false]));
  });

  it("reads a refreshed agent schema as current without writing", () => {
    const pathname = path.join(makeTempDir(tempDirs, "openclaw-planner-agent-"), "agent.sqlite");
    {
      using writer = openNodeSqliteDatabase(pathname);
      writer.exec(OPENCLAW_AGENT_SCHEMA_SQL);
    }
    expect(readOnlyAnswer(pathname)).toBe(sqliteWouldRefresh(pathname));
    {
      using writer = openNodeSqliteDatabase(pathname);
      refreshSqlitePlannerStatistics(writer);
    }
    const before = fs.readFileSync(pathname);
    expect(readOnlyAnswer(pathname)).toBe(false);
    expect(sqliteWouldRefresh(pathname)).toBe(false);
    expect(fs.readFileSync(pathname).equals(before)).toBe(true);
  });
});
