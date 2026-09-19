import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { retainSqliteReader, withSqliteReaderOwner } from "./sqlite-reader-lifecycle.js";
import { configureSqliteWalMaintenance } from "./sqlite-wal.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("SQLite WAL checkpoint observations", () => {
  it("keeps a completed checkpoint successful when file-size observation fails", () => {
    const databasePath = path.join(tempDirs.make("openclaw-wal-size-error-"), "state.sqlite");
    const { DatabaseSync } = requireNodeSqlite();
    const writer = new DatabaseSync(databasePath);
    const onCheckpointError = vi.fn();
    const maintenance = configureSqliteWalMaintenance(writer, {
      databasePath,
      checkpointIntervalMs: 0,
      onCheckpointError,
    });
    writer.exec("CREATE TABLE events (value TEXT); INSERT INTO events VALUES ('committed');");
    const failure = new Error("file-size observation unavailable");
    const stat = vi.spyOn(fs, "statSync").mockImplementationOnce(() => {
      throw failure;
    });
    try {
      expect(maintenance.checkpoint()).toBe(true);
      expect(maintenance.health).toMatchObject({
        state: "complete",
        warning: false,
        error: "file-size observation unavailable",
        lastCompletedAtMs: expect.any(Number),
      });
      expect(onCheckpointError).toHaveBeenCalledWith(failure);
    } finally {
      stat.mockRestore();
      maintenance.close();
      writer.close();
    }
  });

  it.each([
    { checkpointMode: "TRUNCATE", readBigInts: false, returnArrays: false },
    { checkpointMode: "PASSIVE", readBigInts: false, returnArrays: false },
    { checkpointMode: "PASSIVE", readBigInts: true, returnArrays: false },
    { checkpointMode: "PASSIVE", readBigInts: false, returnArrays: true },
  ] as const)(
    "records a $checkpointMode checkpoint blocked by another connection's reader (BigInt=$readBigInts, arrays=$returnArrays)",
    ({ checkpointMode, readBigInts, returnArrays }) => {
      const tempDir = tempDirs.make("openclaw-sqlite-checkpoint-busy-");
      const databasePath = path.join(tempDir, "state.sqlite");
      const { DatabaseSync } = requireNodeSqlite();
      const writer = new DatabaseSync(databasePath, { readBigInts, returnArrays });
      let reader: InstanceType<typeof DatabaseSync> | undefined;
      let maintenance: ReturnType<typeof configureSqliteWalMaintenance> | undefined;
      try {
        writer.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE events (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO events (value) VALUES ('before-reader');
        PRAGMA wal_checkpoint(TRUNCATE);
      `);
        reader = new DatabaseSync(databasePath);
        reader.exec("BEGIN;");
        reader.prepare("SELECT COUNT(*) FROM events").get();
        writer.prepare("INSERT INTO events (value) VALUES (?)").run("after-reader");

        maintenance = configureSqliteWalMaintenance(writer, {
          checkpointIntervalMs: 0,
          checkpointMode,
          databasePath,
        });

        expect(maintenance.checkpoint()).toBe(false);
        expect(maintenance.inspectIdle?.()).toBe("healthy");
        expect(maintenance.health).toMatchObject({
          state: "blocked",
          logFrames: 1,
          checkpointedFrames: 0,
          walBytes: fs.statSync(`${databasePath}-wal`).size,
          databaseBytes: fs.statSync(databasePath).size,
          consecutiveBlocked: 1,
          lastCompletedAtMs: null,
          warning: false,
        });
        expect(maintenance.checkpoint()).toBe(false);
        expect(maintenance.health).toMatchObject({ consecutiveBlocked: 2, warning: true });
        reader.exec("ROLLBACK;");
        expect(maintenance.checkpoint()).toBe(true);
        expect(maintenance.health).toMatchObject({
          state: "complete",
          consecutiveBlocked: 0,
          lastCompletedAtMs: expect.any(Number),
          warning: false,
        });
      } finally {
        if (reader?.isOpen) {
          try {
            reader.exec("ROLLBACK;");
          } catch {}
          reader.close();
        }
        maintenance?.close();
        writer.close();
      }
    },
  );

  it("refuses retention after a native row-decoding failure until the reader is returned", () => {
    const databasePath = path.join(tempDirs.make("openclaw-wal-idle-reader-"), "state.sqlite");
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    const maintenance = configureSqliteWalMaintenance(db, { checkpointIntervalMs: 0 });
    db.exec("CREATE TABLE events (value INTEGER); INSERT INTO events VALUES (9007199254740993)");
    db.exec("PRAGMA query_only=ON");
    const reader = db.prepare("SELECT value FROM events").iterate();
    try {
      expect(maintenance.inspectIdle?.()).toBe("healthy");
      expect(() => reader.next()).toThrow(RangeError);
      expect(db.isTransaction).toBe(false);
      expect(maintenance.inspectIdle?.()).toBe("retire");
      reader.return?.();
      expect(maintenance.inspectIdle?.()).toBe("healthy");
    } finally {
      reader.return?.();
      maintenance.close();
      db.close();
    }
  });

  it("does not report unsupported non-WAL maintenance as healthy", () => {
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(":memory:");
    const maintenance = configureSqliteWalMaintenance(db, { checkpointIntervalMs: 0 });
    try {
      expect(maintenance.checkpoint()).toBe(true);
      expect(maintenance.inspectIdle).toBeUndefined();
    } finally {
      maintenance.close();
      db.close();
    }
  });

  it("reports the process-local reader owner blocking a checkpoint", () => {
    const databasePath = path.join(tempDirs.make("openclaw-sqlite-reader-owner-"), "state.sqlite");
    const { DatabaseSync } = requireNodeSqlite();
    const writer = new DatabaseSync(databasePath);
    const reader = new DatabaseSync(databasePath);
    let releaseReader: (() => void) | undefined;
    const maintenance = configureSqliteWalMaintenance(writer, {
      checkpointIntervalMs: 0,
      checkpointMode: "PASSIVE",
      databasePath,
    });
    try {
      writer.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE events (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO events (value) VALUES ('before-reader');
        PRAGMA wal_checkpoint(TRUNCATE);
      `);
      reader.exec("BEGIN");
      reader.prepare("SELECT COUNT(*) FROM events").get();
      releaseReader = withSqliteReaderOwner(
        { operation: "fixture.blocked-read", ownerKind: "worker", actorId: 9 },
        () => {
          const retained = retainSqliteReader(reader, "fixture reader");
          return () => retained.release();
        },
      );
      writer.prepare("INSERT INTO events (value) VALUES (?)").run("after-reader");

      expect(maintenance.checkpoint()).toBe(false);
      expect(maintenance.health).toMatchObject({
        state: "blocked",
        activeReaders: [
          expect.objectContaining({
            operation: "fixture.blocked-read",
            ownerKind: "worker",
            actorId: 9,
          }),
        ],
      });
    } finally {
      releaseReader?.();
      if (reader.isTransaction) {
        reader.exec("ROLLBACK");
      }
      maintenance.close();
      reader.close();
      writer.close();
    }
  });
});
