import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import * as sqliteIntegrity from "../infra/sqlite-integrity.js";
import { compactDoctorSqliteFile } from "./doctor-sqlite-compact.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function createCompactDatabase(): string {
  const sqlitePath = path.join(tempDirs.make("doctor-compact-noop-"), "store.sqlite");
  const database = openNodeSqliteDatabase(sqlitePath);
  try {
    database.exec(`
      PRAGMA auto_vacuum = INCREMENTAL;
      PRAGMA journal_mode = WAL;
      CREATE TABLE payload (id INTEGER PRIMARY KEY, body TEXT);
      INSERT INTO payload VALUES (1, 'preserved');
    `);
  } finally {
    database.close();
  }
  return sqlitePath;
}

describe("import-finalize compaction", () => {
  it("verifies an already compact store once without rewriting it", () => {
    const sqlitePath = createCompactDatabase();
    const before = fs.readFileSync(sqlitePath);
    const integrity = vi.spyOn(sqliteIntegrity, "assertSqliteIntegrity");
    const afterSuccess = vi.fn();

    const result = compactDoctorSqliteFile({
      sqlitePath,
      operation: "import-finalize",
      afterSuccess,
    });

    expect(result.before).toMatchObject({ autoVacuum: 2, freelistPages: 0, walSizeBytes: 0 });
    expect(result.after).toEqual(result.before);
    expect(result.integrityCheck).toBe("ok");
    expect(result.reclaimedBytes).toBe(0);
    // Each call scans the entire file: a no-op must not double that I/O budget.
    expect(integrity).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(sqlitePath)).toEqual(before);
    expect(afterSuccess).toHaveBeenCalledOnce();
  });

  it("still rejects foreign-key corruption when there is nothing to compact", () => {
    const sqlitePath = createCompactDatabase();
    const database = openNodeSqliteDatabase(sqlitePath);
    try {
      database.exec(`PRAGMA foreign_keys = OFF;
        CREATE TABLE child (parent_id INTEGER REFERENCES payload(id));
        INSERT INTO child VALUES (99);`);
    } finally {
      database.close();
    }
    const afterSuccess = vi.fn();
    expect(() =>
      compactDoctorSqliteFile({ sqlitePath, operation: "import-finalize", afterSuccess }),
    ).toThrow(/foreign_key_check failed/);
    expect(afterSuccess).not.toHaveBeenCalled();
  });

  it("does not skip a busy WAL checkpoint on a store with no free pages", () => {
    const sqlitePath = createCompactDatabase();
    const reader = openNodeSqliteDatabase(sqlitePath);
    const writer = openNodeSqliteDatabase(sqlitePath);
    try {
      reader.exec("BEGIN; SELECT * FROM payload;");
      writer.exec("INSERT INTO payload VALUES (2, 'pending checkpoint');");
      expect(writer.prepare("PRAGMA freelist_count").get()?.freelist_count).toBe(0);
      expect(fs.statSync(`${sqlitePath}-wal`).size).toBeGreaterThan(0);
      expect(() =>
        compactDoctorSqliteFile({ sqlitePath, operation: "import-finalize", busyTimeoutMs: 0 }),
      ).toThrow(/checkpoint remained busy/);
    } finally {
      reader.exec("ROLLBACK;");
      reader.close();
      writer.close();
    }
  });
});
