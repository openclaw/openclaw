import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import * as sqliteIntegrity from "../infra/sqlite-integrity.js";
import * as walCheckpoint from "../infra/sqlite-wal-checkpoint.js";
import { createUnsafeIndexDrift } from "../state/sqlite-index-drift.test-support.js";
import { compactDoctorSqliteFile } from "./doctor-sqlite-compact.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function createCompactDatabase(extraSql = "", autoVacuum = 2): string {
  const sqlitePath = path.join(tempDirs.make("doctor-compact-noop-"), "store.sqlite");
  using database = openNodeSqliteDatabase(sqlitePath);
  database.exec(`
      PRAGMA auto_vacuum = ${autoVacuum};
      PRAGMA journal_mode = WAL;
      CREATE TABLE payload (id INTEGER PRIMARY KEY, body TEXT);
      INSERT INTO payload VALUES (1, 'preserved');
      ${extraSql}
    `);
  return sqlitePath;
}

it.each([
  ["missing", undefined, expect.any(Error)],
  ["compact", "", undefined],
  [
    "foreign-key-corrupt",
    "PRAGMA foreign_keys=OFF; CREATE TABLE child(parent_id INTEGER REFERENCES payload(id)); INSERT INTO child VALUES(99);",
    /foreign_key_check failed/,
  ],
  [
    "index-corrupt",
    "INSERT INTO payload VALUES(2, zeroblob(1048576)); DELETE FROM payload WHERE id=2;",
    /integrity_check failed.*missing from index unsafe_index_records_value/iu,
  ],
])("validates %s input before completing compaction", (state, sql, error) => {
  const sqlitePath =
    sql === undefined
      ? path.join(tempDirs.make("doctor-compact-missing-"), "missing.sqlite")
      : createCompactDatabase(sql, state === "index-corrupt" ? 0 : 2);
  if (state === "index-corrupt") {
    createUnsafeIndexDrift(sqlitePath);
  }
  const before = fs.existsSync(sqlitePath) ? fs.readFileSync(sqlitePath) : undefined;
  const afterSuccess = vi.fn();
  const compact = () =>
    compactDoctorSqliteFile({
      sqlitePath,
      requireExisting: state === "missing",
      operation: "import-finalize",
      afterSuccess,
    });
  if (error) {
    expect(compact).toThrow(error);
    expect(afterSuccess).not.toHaveBeenCalled();
    if (state === "missing") {
      expect(fs.existsSync(sqlitePath)).toBe(false);
    } else {
      expect(fs.readFileSync(sqlitePath)).toEqual(before);
    }
    return;
  }
  const integrity = vi.spyOn(sqliteIntegrity, "assertSqliteIntegrity");
  const result = compact();
  expect(result.before).toMatchObject({ autoVacuum: 2, freelistPages: 0, walSizeBytes: 0 });
  expect(result.after).toEqual(result.before);
  expect(result).toMatchObject({ integrityCheck: "ok", reclaimedBytes: 0 });
  // Each call scans the entire file: a no-op must not double that I/O budget.
  expect(integrity).toHaveBeenCalledTimes(1);
  expect(fs.readFileSync(sqlitePath)).toEqual(before);
  expect(afterSuccess).toHaveBeenCalledOnce();
});

it.each([false, true])("rejects an initial busy checkpoint (close fails=%s)", (closeFails) => {
  const sqlitePath = createCompactDatabase();
  using reader = openNodeSqliteDatabase(sqlitePath);
  using writer = openNodeSqliteDatabase(sqlitePath);
  const closeFailure = new Error("native close failure");
  const afterSuccess = vi.fn();
  if (closeFails) {
    const openDatabase = nodeSqlite.openNodeSqliteDatabase;
    vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
      const database = openDatabase(...args);
      const close = database.close.bind(database);
      database.close = () => {
        close();
        throw closeFailure;
      };
      return database;
    });
  }
  try {
    reader.exec("BEGIN; SELECT * FROM payload;");
    writer.exec("INSERT INTO payload VALUES (2, 'pending checkpoint');");
    expect(writer.prepare("PRAGMA freelist_count").get()?.freelist_count).toBe(0);
    expect(fs.statSync(`${sqlitePath}-wal`).size).toBeGreaterThan(0);
    if (!closeFails) {
      expect(() =>
        compactDoctorSqliteFile({
          sqlitePath,
          operation: "import-finalize",
          busyTimeoutMs: 0,
          afterSuccess,
        }),
      ).toThrow(/checkpoint remained busy/);
      expect(afterSuccess).not.toHaveBeenCalled();
      return;
    }
    expect(() => compactDoctorSqliteFile({ sqlitePath, busyTimeoutMs: 0, afterSuccess })).toThrow(
      expect.objectContaining({
        constructor: AggregateError,
        errors: [expect.any(walCheckpoint.SqliteWalCheckpointBusyError), closeFailure],
      }),
    );
    expect(afterSuccess).not.toHaveBeenCalled();
  } finally {
    reader.exec("ROLLBACK;");
  }
});

it("does not defer a real busy checkpoint after compaction", () => {
  const sqlitePath = createCompactDatabase();
  const truncate = walCheckpoint.truncateSqliteWal;
  let checkpointCalls = 0;
  let reader: ReturnType<typeof openNodeSqliteDatabase> | undefined;
  vi.spyOn(walCheckpoint, "truncateSqliteWal").mockImplementation((database, pathname) => {
    if (++checkpointCalls === 2) {
      reader = openNodeSqliteDatabase(pathname, { readOnly: true });
      reader.exec("BEGIN; SELECT * FROM payload;");
    }
    return truncate(database, pathname);
  });
  try {
    expect(() => compactDoctorSqliteFile({ sqlitePath, busyTimeoutMs: 0 })).toThrow(
      walCheckpoint.SqliteWalCheckpointBusyError,
    );
    expect(checkpointCalls).toBe(2);
  } finally {
    reader?.exec("ROLLBACK;");
    reader?.close();
  }
});
