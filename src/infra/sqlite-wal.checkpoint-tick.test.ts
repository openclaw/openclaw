// Covers the WAL checkpoint tick and inline autocheckpoint threshold.
import fs from "node:fs";
import path from "node:path";
import { setImmediate as realImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  cancelSqliteWalWriteAdmission,
  registerSqliteWalWorkerMaintenance,
} from "./sqlite-wal-write-admission.js";
import { configureSqlitePreSchemaPragmas, configureSqliteWalMaintenance } from "./sqlite-wal.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("sqlite WAL checkpoint tick", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("keeps scheduled writers off commit checkpoints through delegation and retirement", async () => {
    vi.useFakeTimers();
    const sqlite = requireNodeSqlite();
    const dir = tempDirs.make("openclaw-sqlite-wal-worker-writer-");
    const dbPath = path.join(dir, "openclaw.sqlite");
    const db = new sqlite.DatabaseSync(dbPath);
    const autocheckpoint = () =>
      Number(
        (db.prepare("PRAGMA wal_autocheckpoint;").get() as { wal_autocheckpoint: number | bigint })
          .wal_autocheckpoint,
      );
    let maintenance: ReturnType<typeof configureSqliteWalMaintenance> | undefined;
    try {
      maintenance = configureSqliteWalMaintenance(db, {
        checkpointIntervalMs: 60_000,
        databaseLabel: "wal-worker-writer",
        databasePath: dbPath,
      });
      // Native worker handles use this policy before any host delegation is registered.
      expect(autocheckpoint()).toBe(0);

      let cancelled = 0;
      const requests: number[] = [];
      registerSqliteWalWorkerMaintenance(
        db,
        async (request) => {
          requests.push(request.maxPages);
          return undefined;
        },
        () => {
          cancelled += 1;
        },
      );
      expect(autocheckpoint()).toBe(0);

      await vi.advanceTimersByTimeAsync(50_000);
      expect(requests).toEqual([]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(requests).toEqual([512]);

      // Retirement owns the final checkpoint; cancelling delegation must not rearm COMMIT work.
      void cancelSqliteWalWriteAdmission(db);
      expect(cancelled).toBe(1);
      expect(autocheckpoint()).toBe(0);
    } finally {
      maintenance?.close();
      db.close();
    }
  });

  it.each([
    { checkpointIntervalMs: 0, expected: 16_384 },
    { checkpointIntervalMs: 60_000, autoCheckpointPages: 7, expected: 7 },
  ])("preserves explicitly selected checkpoint policy (%j)", (options) => {
    const { DatabaseSync } = requireNodeSqlite();
    const dbPath = path.join(tempDirs.make("openclaw-sqlite-wal-policy-"), "openclaw.sqlite");
    const db = new DatabaseSync(dbPath);
    const maintenance = configureSqliteWalMaintenance(db, options);
    try {
      expect(Number(db.prepare("PRAGMA wal_autocheckpoint").get()?.wal_autocheckpoint)).toBe(
        options.expected,
      );
    } finally {
      maintenance.close();
      db.close();
    }
  });

  it("checkpoints WAL pressure on the next maintenance wake", async () => {
    vi.useFakeTimers();
    const { DatabaseSync } = requireNodeSqlite();
    const dbPath = path.join(tempDirs.make("openclaw-sqlite-wal-pressure-"), "openclaw.sqlite");
    const db = new DatabaseSync(dbPath);
    const maintenance = configureSqliteWalMaintenance(db, { databasePath: dbPath });
    try {
      db.exec("CREATE TABLE payload (value TEXT); INSERT INTO payload VALUES ('committed');");
      let reportedWalBytes = 64 * 1024 * 1024;
      const nativeStat = fs.statSync;
      // A recycled WAL at the retained limit must not force every pressure wake.
      vi.spyOn(fs, "statSync").mockImplementation((...args) => {
        const stat = nativeStat(...args);
        if (stat && args[0] === `${dbPath}-wal` && typeof stat.size === "number") {
          stat.size = reportedWalBytes;
        }
        return stat;
      });
      await vi.advanceTimersByTimeAsync(250);
      expect(maintenance.health).toBeUndefined();
      reportedWalBytes += 1;
      await vi.advanceTimersByTimeAsync(250);
      const health = expectDefined(maintenance.health, "pressure checkpoint");
      expect(health.state).toBe("complete");
      expect(health.checkpointedFrames).toBeGreaterThan(0);
      expect(health.checkpointedFrames).toBe(health.logFrames);
      expect(fs.readFileSync(`${dbPath}-wal`).length).toBeGreaterThan(0);
      reportedWalBytes = 1024 * 1024 * 1024 + 1;
      await vi.advanceTimersByTimeAsync(250);
      expect(fs.readFileSync(`${dbPath}-wal`)).toHaveLength(0);
      expect(db.prepare("SELECT value FROM payload").get()?.value).toBe("committed");
      const truncatedAt = maintenance.health?.observedAtMs;
      reportedWalBytes = 0;
      db.exec("INSERT INTO payload VALUES ('next');");
      await vi.advanceTimersByTimeAsync(9_000);
      expect(maintenance.health?.observedAtMs).toBe(truncatedAt);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(maintenance.health?.observedAtMs).toBeGreaterThan(truncatedAt ?? 0);
      expect(maintenance.health?.state).toBe("complete");
    } finally {
      maintenance.close();
      db.close();
    }
  });

  it("joins admitted maintenance before native close and refuses subsequent wakes", async () => {
    vi.useFakeTimers();
    const sqlite = requireNodeSqlite();
    const dbPath = path.join(tempDirs.make("openclaw-sqlite-wal-retirement-"), "openclaw.sqlite");
    const db = new sqlite.DatabaseSync(dbPath);
    const maintenance = configureSqliteWalMaintenance(db, { checkpointIntervalMs: 100 });
    const entered = createDeferredCore();
    const released = createDeferredCore();
    const execute = vi.fn(async () => {
      entered.resolve();
      await released.promise;
      expect(db.isOpen).toBe(true);
      return undefined;
    });
    registerSqliteWalWorkerMaintenance(db, execute);
    try {
      vi.advanceTimersByTime(100);
      await entered.promise;
      const closed = vi.fn();
      const closing = maintenance.stop().then(() => {
        maintenance.close();
        db.close();
        closed();
      });
      await Promise.resolve();
      expect(closed).not.toHaveBeenCalled();
      released.resolve();
      await closing;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(closed).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      released.resolve();
      await maintenance.stop();
      if (db.isOpen) {
        maintenance.close();
        db.close();
      }
    }
  });

  it("checkpoints on the maintenance tick and vacuums only on the periodic pass", async () => {
    vi.useFakeTimers();
    const sqlite = requireNodeSqlite();
    const dir = tempDirs.make("openclaw-sqlite-wal-tick-");
    const dbPath = path.join(dir, "openclaw.sqlite");
    const db = new sqlite.DatabaseSync(dbPath);
    const freelistCount = () =>
      Number(
        (db.prepare("PRAGMA freelist_count;").get() as { freelist_count: number | bigint })
          .freelist_count,
      );
    // The periodic pass yields between vacuum units on real immediates that fake timers do not own.
    const settle = async () => {
      for (let index = 0; index < 64; index += 1) {
        await realImmediate();
      }
    };
    let maintenance: ReturnType<typeof configureSqliteWalMaintenance> | undefined;
    try {
      configureSqlitePreSchemaPragmas(db);
      maintenance = configureSqliteWalMaintenance(db, {
        checkpointIntervalMs: 60_000,
        databaseLabel: "wal-tick",
        databasePath: dbPath,
      });
      db.exec("CREATE TABLE payload (id INTEGER PRIMARY KEY, value BLOB NOT NULL);");
      const insert = db.prepare("INSERT INTO payload (value) VALUES (?)");
      const value = new Uint8Array(16 * 1024);
      for (let index = 0; index < 64; index += 1) {
        insert.run(value);
      }
      db.exec("DELETE FROM payload;");
      const freeBefore = freelistCount();
      expect(freeBefore).toBeGreaterThan(0);
      // Commits leave every frame for the maintenance tick.
      expect(maintenance.health).toBeUndefined();

      // Ticks checkpoint without vacuuming.
      await vi.advanceTimersByTimeAsync(9_000);
      expect(maintenance.health).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1_000);
      await settle();

      const ticked = expectDefined(maintenance.health, "WAL tick health");
      expect(ticked.state).toBe("complete");
      expect(ticked.checkpointedFrames).toBeGreaterThan(0);
      expect(ticked.checkpointedFrames).toBe(ticked.logFrames);
      expect(freelistCount()).toBe(freeBefore);

      // The periodic pass runs the bounded reclaim.
      await vi.advanceTimersByTimeAsync(50_000);
      await settle();
      expect(freelistCount()).toBeLessThan(freeBefore);
    } finally {
      maintenance?.close();
      db.close();
      vi.useRealTimers();
    }
  });
});
