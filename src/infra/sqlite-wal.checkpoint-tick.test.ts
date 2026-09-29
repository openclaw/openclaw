// Covers the WAL checkpoint tick and inline autocheckpoint threshold.
import path from "node:path";
import { setImmediate as realImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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

  it("raises the inline autocheckpoint threshold to the WAL recycling limit", () => {
    const sqlite = requireNodeSqlite();
    const dir = tempDirs.make("openclaw-sqlite-wal-autocheckpoint-");
    const dbPath = path.join(dir, "openclaw.sqlite");
    const db = new sqlite.DatabaseSync(dbPath);
    let maintenance: ReturnType<typeof configureSqliteWalMaintenance> | undefined;
    try {
      maintenance = configureSqliteWalMaintenance(db, {
        checkpointIntervalMs: 0,
        databaseLabel: "wal-autocheckpoint",
        databasePath: dbPath,
      });
      const row = db.prepare("PRAGMA wal_autocheckpoint;").get() as {
        wal_autocheckpoint: number | bigint;
      };
      expect(Number(row.wal_autocheckpoint)).toBe(16 * 1024);
    } finally {
      maintenance?.close();
      db.close();
    }
  });

  it("disables inline checkpoints on a worker-maintained writer", () => {
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
        checkpointIntervalMs: 0,
        databaseLabel: "wal-worker-writer",
        databasePath: dbPath,
      });
      expect(autocheckpoint()).toBe(16 * 1024);

      let cancelled = 0;
      registerSqliteWalWorkerMaintenance(
        db,
        async () => undefined,
        () => {
          cancelled += 1;
        },
      );
      expect(autocheckpoint()).toBe(0);

      // Without its worker the writer falls back to the bounded inline valve.
      void cancelSqliteWalWriteAdmission(db);
      expect(cancelled).toBe(1);
      expect(autocheckpoint()).toBe(16 * 1024);
    } finally {
      maintenance?.close();
      db.close();
    }
  });

  it("checkpoints on the maintenance tick and vacuums only at the reclaim interval", async () => {
    // The reclaim cadence reads the monotonic clock; fake it with the timers.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date", "performance"] });
    const sqlite = requireNodeSqlite();
    const dir = tempDirs.make("openclaw-sqlite-wal-tick-");
    const dbPath = path.join(dir, "openclaw.sqlite");
    const db = new sqlite.DatabaseSync(dbPath);
    const freelistCount = () =>
      Number(
        (db.prepare("PRAGMA freelist_count;").get() as { freelist_count: number | bigint })
          .freelist_count,
      );
    // The reclaim pass yields between vacuum units on real immediates that fake timers do not own.
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
      const churn = () => {
        for (let index = 0; index < 64; index += 1) {
          insert.run(value);
        }
        db.exec("DELETE FROM payload;");
      };
      churn();
      const freeBefore = freelistCount();
      expect(freeBefore).toBeGreaterThan(0);
      // Commits below the inline threshold leave every frame for the maintenance tick.
      expect(maintenance.health).toBeUndefined();

      // The first fire checkpoints and runs the bounded reclaim pass.
      await vi.advanceTimersByTimeAsync(10_000);
      await settle();

      const ticked = expectDefined(maintenance.health, "WAL tick health");
      expect(ticked.state).toBe("complete");
      expect(ticked.checkpointedFrames).toBeGreaterThan(0);
      expect(ticked.checkpointedFrames).toBe(ticked.logFrames);
      expect(freelistCount()).toBeLessThan(freeBefore);

      churn();
      const freeAgain = freelistCount();
      expect(freeAgain).toBeGreaterThan(0);

      // Ticks inside the reclaim interval only checkpoint.
      await vi.advanceTimersByTimeAsync(40_000);
      await settle();
      const inInterval = expectDefined(maintenance.health, "WAL tick health");
      expect(inInterval.state).toBe("complete");
      expect(inInterval.observedAtMs).toBeGreaterThan(ticked.observedAtMs);
      expect(freelistCount()).toBe(freeAgain);

      // The reclaim interval counts from the first reclaim pass, so the next one lands at 70 s.
      await vi.advanceTimersByTimeAsync(20_000);
      await settle();
      expect(freelistCount()).toBeLessThan(freeAgain);
    } finally {
      maintenance?.close();
      db.close();
      vi.useRealTimers();
    }
  });
});
