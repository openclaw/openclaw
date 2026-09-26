import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { threadId } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getNodeSqliteKysely, iterateSqliteQuerySync } from "./kysely-sync.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "./node-sqlite.js";
import {
  assertNoActiveSqliteReaders,
  readSqliteReaderDiagnosticsForPath,
  retainSqliteReader,
  withSqliteReaderOwner,
} from "./sqlite-reader-lifecycle.js";
import { runSqliteDeferredTransactionSync } from "./sqlite-transaction.js";
import {
  createSqliteWalCheckpoint,
  onSqliteWalCheckpoint,
  publishSqliteWalCheckpointObservation,
  type SqliteWalCheckpointSnapshot,
} from "./sqlite-wal-checkpoint.js";
import { configureSqliteWalMaintenance } from "./sqlite-wal.js";
import { StateDatabaseCoordinatorContentionError } from "./state-database-coordinator-errors.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("SQLite WAL checkpoint observations", () => {
  it("retains relayed health across native generations and rejects older observations", () => {
    const databasePath = path.join(tempDirs.make("openclaw-wal-health-relay-"), "state.sqlite");
    const database = openNodeSqliteDatabase(databasePath);
    database.exec("PRAGMA journal_mode=WAL; CREATE TABLE events(value TEXT)");
    const owner = createSqliteWalCheckpoint(database, { databasePath }, 64 * 1024 * 1024);
    const replacement = createSqliteWalCheckpoint(database, { databasePath }, 64 * 1024 * 1024);
    try {
      expect(owner.checkpoint("PASSIVE")).toBe(true);
      const completed = owner.snapshot!;
      replacement.adopt(completed);
      replacement.recordError(new StateDatabaseCoordinatorContentionError("state-lifecycle"));
      owner.adopt(replacement.snapshot!);
      expect(owner.health).toMatchObject({
        state: "blocked",
        consecutiveBlocked: 1,
        lastCompletedAtMs: completed.health.lastCompletedAtMs,
      });
      owner.recordError(new StateDatabaseCoordinatorContentionError("state-lifecycle"));
      const blocked = owner.snapshot;
      owner.adopt(completed);
      expect(owner.snapshot).toEqual(blocked);
      expect(owner.health).toMatchObject({ consecutiveBlocked: 2, warning: true });
      expect(owner.checkpoint("PASSIVE")).toBe(true);
      owner.adopt(replacement.snapshot!);
      expect(owner.health).toMatchObject({ state: "complete", consecutiveBlocked: 0 });
    } finally {
      database.close();
    }
  });

  it("backs off once per interval, warns in health early, and throttles contention logs", async () => {
    vi.useFakeTimers();
    const databasePath = path.join(
      tempDirs.make("openclaw-wal-coordinator-retry-"),
      "state.sqlite",
    );
    const writer = openNodeSqliteDatabase(databasePath);
    const onCheckpointError = vi.fn();
    let blocked = true;
    const runMaintenance = vi.fn((operation: () => boolean) => {
      if (blocked) {
        throw new StateDatabaseCoordinatorContentionError("state-lifecycle");
      }
      return operation();
    });
    const interval = 30 * 60 * 1000;
    const maintenance = configureSqliteWalMaintenance(writer, {
      databasePath,
      checkpointIntervalMs: interval,
      runMaintenance,
      onCheckpointError,
    });
    try {
      await vi.advanceTimersByTimeAsync(interval);
      expect(runMaintenance).toHaveBeenCalledTimes(1);
      expect(onCheckpointError).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(999);
      expect(runMaintenance).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(runMaintenance).toHaveBeenCalledTimes(2);
      expect(maintenance.health).toMatchObject({
        state: "blocked",
        consecutiveBlocked: 2,
        warning: true,
      });
      expect(onCheckpointError).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(interval);
      expect(runMaintenance).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(interval - 1_000);
      expect(runMaintenance).toHaveBeenCalledTimes(5);
      expect(onCheckpointError).toHaveBeenCalledTimes(1);
      expect(maintenance.health).toMatchObject({
        state: "blocked",
        consecutiveBlocked: 5,
        warning: true,
      });
      await vi.advanceTimersByTimeAsync(2 * interval + 1_000);
      expect(runMaintenance).toHaveBeenCalledTimes(10);
      expect(onCheckpointError).toHaveBeenCalledTimes(2);
      blocked = false;
      await vi.advanceTimersByTimeAsync(interval - 1_000);
      expect(runMaintenance).toHaveBeenCalledTimes(11);
      expect(maintenance.health).toMatchObject({
        state: "complete",
        consecutiveBlocked: 0,
        warning: false,
      });
      expect(onCheckpointError).toHaveBeenCalledTimes(2);
      blocked = true;
      await vi.advanceTimersByTimeAsync(interval);
      expect(maintenance.health?.consecutiveBlocked).toBe(1);
      maintenance.close();
      const callsAtClose = runMaintenance.mock.calls.length;
      await vi.advanceTimersByTimeAsync(interval);
      expect(runMaintenance).toHaveBeenCalledTimes(callsAtClose);
    } finally {
      maintenance.close();
      writer.close();
      vi.useRealTimers();
    }
  });

  it("recycles an oversized completed WAL during admitted periodic maintenance without waiting for readers", async () => {
    vi.useFakeTimers();
    const databasePath = path.join(tempDirs.make("openclaw-wal-recycle-"), "state.sqlite");
    const { DatabaseSync } = requireNodeSqlite();
    const writer = new DatabaseSync(databasePath);
    let reader: InstanceType<typeof DatabaseSync> | undefined;
    let admitted = false;
    const maintenance = configureSqliteWalMaintenance(writer, {
      databasePath,
      autoCheckpointPages: 0,
      busyTimeoutMs: 5_000,
      checkpointIntervalMs: 100,
      runMaintenance: (operation) => admitted && operation(),
    });
    try {
      writer.exec(
        "CREATE TABLE payload(value BLOB); INSERT INTO payload VALUES(zeroblob(1048576));",
      );
      for (let index = 0; index < 65; index++) {
        writer.exec("UPDATE payload SET value=randomblob(1048576)");
      }
      const oversized = fs.statSync(`${databasePath}-wal`).size;
      expect(oversized).toBeGreaterThan(64 * 1024 * 1024);
      await vi.advanceTimersByTimeAsync(100);
      expect(fs.statSync(`${databasePath}-wal`).size).toBe(oversized);
      reader = new DatabaseSync(databasePath, { readOnly: true });
      reader.exec("BEGIN");
      expect(reader.prepare("SELECT length(value) AS bytes FROM payload").get()?.bytes).toBe(
        1048576,
      );
      admitted = true;
      const started = performance.now();
      await vi.advanceTimersByTimeAsync(100);
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(fs.statSync(`${databasePath}-wal`).size).toBe(oversized);
      expect(maintenance.health?.state).toBe("blocked");
      expect(writer.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(5_000);
      reader.exec("ROLLBACK");
      await vi.advanceTimersByTimeAsync(100);
      expect(fs.statSync(`${databasePath}-wal`).size).toBeLessThanOrEqual(64 * 1024 * 1024);
      expect(maintenance.health?.state).toBe("complete");
      expect(writer.prepare("SELECT length(value) AS bytes FROM payload").get()?.bytes).toBe(
        1048576,
      );
    } finally {
      reader?.close();
      maintenance.close();
      writer.close();
      vi.useRealTimers();
    }
  });

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
    const db = openNodeSqliteDatabase(databasePath);
    const maintenance = configureSqliteWalMaintenance(db, {
      databasePath,
      checkpointIntervalMs: 0,
    });
    db.exec("CREATE TABLE events (value INTEGER); INSERT INTO events VALUES (9007199254740993)");
    db.exec("PRAGMA query_only=ON");
    const reader = db.prepare("SELECT value FROM events").iterate();
    try {
      expect(maintenance.inspectIdle?.()).toBe("healthy");
      expect(() => reader.next()).toThrow(RangeError);
      expect(db.isTransaction).toBe(false);
      expect(maintenance.inspectIdle?.()).toBe("retire");
      expect(maintenance.health?.activeReaders).toEqual([]);
      expect(() => assertNoActiveSqliteReaders(db, "native idle probe")).not.toThrow();
      reader.return?.();
      expect(maintenance.inspectIdle?.()).toBe("healthy");
      expect(readSqliteReaderDiagnosticsForPath(databasePath).activeReaders).toEqual([]);
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

  it("reports a named Kysely reader without claiming it is the blocking owner", () => {
    const databasePath = path.join(tempDirs.make("openclaw-sqlite-reader-owner-"), "state.sqlite");
    const writer = openNodeSqliteDatabase(databasePath);
    const reader = openNodeSqliteDatabase(databasePath);
    const maintenance = configureSqliteWalMaintenance(writer, {
      checkpointIntervalMs: 0,
      checkpointMode: "PASSIVE",
      databasePath,
    });
    writer.exec(
      "CREATE TABLE events(value TEXT); INSERT INTO events VALUES ('before-reader'); PRAGMA wal_checkpoint(TRUNCATE)",
    );
    const held = withSqliteReaderOwner(
      { operation: "fixture.blocked-read", ownerKind: "main" },
      () =>
        iterateSqliteQuerySync(
          reader,
          getNodeSqliteKysely<{ events: { value: string } }>(reader)
            .selectFrom("events")
            .select("value"),
        ),
    );
    try {
      held.next();
      writer.prepare("INSERT INTO events (value) VALUES (?)").run("after-reader");
      expect(maintenance.checkpoint()).toBe(false);
      expect(maintenance.health).toMatchObject({
        state: "blocked",
        activeReaders: [
          expect.objectContaining({
            operation: "fixture.blocked-read",
            ownerKind: "main",
            kind: "iterator",
            connectionId: expect.any(Number),
            threadId,
          }),
        ],
        readerDiagnostics: [
          expect.objectContaining({
            scope: "current-thread",
            blockingOwner: "unknown",
            nativeStatements: "unobserved",
            threadId,
            connectionCount: 2,
            readerCount: 1,
          }),
        ],
      });
      expect(JSON.stringify(maintenance.health)).not.toContain("SELECT");
      held.return?.();
      expect(maintenance.checkpoint()).toBe(true);
      expect(maintenance.health?.activeReaders).toBeUndefined();
      expect(readSqliteReaderDiagnosticsForPath(databasePath).activeReaders).toEqual([]);
    } finally {
      held.return?.();
      reader.close();
      maintenance.close();
      writer.close();
    }
  });

  it("observes native transaction state without claiming custody and publishes checkpoint completion", () => {
    const databasePath = path.join(tempDirs.make("openclaw-wal-reader-event-"), "state.sqlite");
    const writer = openNodeSqliteDatabase(databasePath);
    const reader = withSqliteReaderOwner(
      { operation: "fixture.open-reader", ownerKind: "main" },
      () => openNodeSqliteDatabase(databasePath),
    );
    const maintenance = configureSqliteWalMaintenance(writer, {
      databasePath,
      checkpointIntervalMs: 0,
      busyTimeoutMs: 0,
    });
    const states: string[] = [];
    const observations: SqliteWalCheckpointSnapshot[] = [];
    const unsubscribe = onSqliteWalCheckpoint((observation) => {
      if (observation.databasePath === databasePath) {
        expect(maintenance.health?.state).toBe(observation.health.state);
        states.push(observation.health.state);
        observations.push({ health: observation.health, observedAtNs: observation.observedAtNs });
      }
    });
    try {
      writer.exec("CREATE TABLE events(value TEXT); INSERT INTO events VALUES ('before');");
      runSqliteDeferredTransactionSync(
        reader,
        () => {
          reader.prepare("SELECT value FROM events").get();
          writer.exec("INSERT INTO events VALUES ('after');");
          expect(maintenance.checkpoint()).toBe(false);
          expect(maintenance.health?.activeReaders).toEqual([]);
          expect(maintenance.health?.readerDiagnostics?.[0]?.connections).toContainEqual(
            expect.objectContaining({
              operation: "fixture.open-reader",
              transactionOpen: true,
              trackedReaders: 0,
            }),
          );
          expect(() =>
            assertNoActiveSqliteReaders(reader, "native transaction probe"),
          ).not.toThrow();
          const observed = publishSqliteWalCheckpointObservation(databasePath, observations[0]!);
          expect(observed.health.activeReaders).toHaveLength(0);
          expect(observed.health.readerDiagnostics).toHaveLength(1);
        },
        { operationLabel: "fixture.named-transaction" },
      );
      expect(maintenance.checkpoint()).toBe(true);
      expect(states).toEqual(["blocked", "blocked", "complete"]);
      expect(fs.statSync(`${databasePath}-wal`).size).toBe(0);
    } finally {
      unsubscribe();
      reader.close();
      maintenance.close();
      writer.close();
    }
  });

  it("bounds connection and reader detail while reporting omitted local activity", () => {
    const databasePath = path.join(tempDirs.make("openclaw-wal-reader-bound-"), "state.sqlite");
    const writer = openNodeSqliteDatabase(databasePath);
    const readers: Array<ReturnType<typeof openNodeSqliteDatabase>> = [];
    const releaseReaders: Array<() => void> = [];
    const maintenance = configureSqliteWalMaintenance(writer, {
      databasePath,
      checkpointIntervalMs: 0,
      checkpointMode: "PASSIVE",
    });
    try {
      writer.exec("CREATE TABLE events(value TEXT); INSERT INTO events VALUES ('before');");
      for (let index = 0; index < 10; index++) {
        withSqliteReaderOwner({ operation: `fixture.reader-${index}`, ownerKind: "main" }, () => {
          const reader = openNodeSqliteDatabase(databasePath);
          readers.push(reader);
          const iterator = iterateSqliteQuerySync(
            reader,
            getNodeSqliteKysely<{ events: { value: string } }>(reader)
              .selectFrom("events")
              .select("value"),
          );
          releaseReaders.push(() => {
            iterator.return?.();
          });
          iterator.next();
        });
      }
      writer.exec("INSERT INTO events VALUES ('after');");
      expect(maintenance.checkpoint()).toBe(false);
      expect(maintenance.health?.activeReaders).toHaveLength(8);
      expect(maintenance.health?.readerDiagnostics).toEqual([
        expect.objectContaining({ connectionCount: 11, readerCount: 10 }),
      ]);
      expect(maintenance.health?.readerDiagnostics?.[0]?.connections).toHaveLength(8);
    } finally {
      for (const release of releaseReaders) {
        release();
      }
      for (const reader of readers) {
        reader.close();
      }
      maintenance.close();
      writer.close();
    }
  });

  it("does not settle explicit reader custody when forgetting closed connection metadata", () => {
    const databasePath = path.join(tempDirs.make("openclaw-reader-custody-"), "state.sqlite");
    const database = openNodeSqliteDatabase(databasePath);
    const owned = retainSqliteReader(database, "fixture.owned-reader");
    try {
      database.close();
      expect(readSqliteReaderDiagnosticsForPath(databasePath).connectionCount).toBe(0);
      expect(() => assertNoActiveSqliteReaders(database, "fixture")).toThrow(
        "fixture.owned-reader",
      );
      owned.release();
      expect(() => assertNoActiveSqliteReaders(database, "fixture")).not.toThrow();
    } finally {
      owned.release();
      if (database.isOpen) {
        database.close();
      }
    }
  });
});
