import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import * as sqliteIntegrity from "../infra/sqlite-integrity.js";
import * as walCheckpoint from "../infra/sqlite-wal-checkpoint.js";
import {
  compactDoctorSqliteFile,
  DoctorSqliteCompactionDeferredError,
} from "./doctor-sqlite-compact.js";

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
  it.each(["missing", "compact", "foreign-key-corrupt"] as const)(
    "validates %s input before completing compaction",
    (state) => {
      if (state === "missing") {
        const sqlitePath = path.join(tempDirs.make("doctor-compact-missing-"), "missing.sqlite");
        expect(() => compactDoctorSqliteFile({ sqlitePath, requireExisting: true })).toThrow();
        expect(fs.existsSync(sqlitePath)).toBe(false);
        return;
      }
      const sqlitePath = createCompactDatabase();
      const afterSuccess = vi.fn();
      if (state === "foreign-key-corrupt") {
        const database = openNodeSqliteDatabase(sqlitePath);
        try {
          database.exec(`PRAGMA foreign_keys = OFF;
            CREATE TABLE child (parent_id INTEGER REFERENCES payload(id));
            INSERT INTO child VALUES (99);`);
        } finally {
          database.close();
        }
        expect(() =>
          compactDoctorSqliteFile({ sqlitePath, operation: "import-finalize", afterSuccess }),
        ).toThrow(/foreign_key_check failed/);
        expect(afterSuccess).not.toHaveBeenCalled();
        return;
      }
      const before = fs.readFileSync(sqlitePath);
      const integrity = vi.spyOn(sqliteIntegrity, "assertSqliteIntegrity");
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
    },
  );

  it.each([false, true])("rejects an initial busy checkpoint (close fails=%s)", (closeFails) => {
    const sqlitePath = createCompactDatabase();
    const reader = openNodeSqliteDatabase(sqlitePath);
    const writer = openNodeSqliteDatabase(sqlitePath);
    const closeFailure = new Error("native close failure");
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
          compactDoctorSqliteFile({ sqlitePath, operation: "import-finalize", busyTimeoutMs: 0 }),
        ).toThrow(/checkpoint remained busy/);
        return;
      }
      let failure: unknown;
      try {
        compactDoctorSqliteFile({ sqlitePath, busyTimeoutMs: 0 });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure).not.toBeInstanceOf(DoctorSqliteCompactionDeferredError);
      expect(failure instanceof AggregateError && failure.errors).toEqual([
        expect.any(walCheckpoint.SqliteWalCheckpointBusyError),
        closeFailure,
      ]);
    } finally {
      reader.exec("ROLLBACK;");
      reader.close();
      writer.close();
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
});
