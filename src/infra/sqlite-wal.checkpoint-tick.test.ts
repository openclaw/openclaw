import { setImmediate as realImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createEnteredGate } from "../agents/entered-gate.test-support.js";
import {
  sqliteMaintenanceFixture,
  sqliteSchedulerClock,
} from "./sqlite-maintenance-fixture.test-support.js";
import {
  cancelSqliteWalWriteAdmission,
  registerSqliteWalWorkerMaintenance,
} from "./sqlite-wal-write-admission.js";
import { configureSqlitePreSchemaPragmas } from "./sqlite-wal.js";

const resources = sqliteMaintenanceFixture();

function createDatabase() {
  const dbPath = resources.file();
  const db = resources.open(dbPath);
  const pragma = (name: string) => Number(db.prepare(`PRAGMA ${name};`).get()?.[name]);
  return { db, dbPath, pragma };
}

describe("sqlite WAL checkpoint tick", () => {
  it.each(["before", "after"])(
    "cancels delegated checkpoint wakeups when registered %s configuration",
    async (registrationOrder) => {
      const clock = sqliteSchedulerClock();
      const { db, dbPath, pragma } = createDatabase();
      let cancelled = 0;
      const requests: number[] = [];
      const registerWorker = () =>
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
      if (registrationOrder === "before") {
        registerWorker();
      }
      const maintenance = resources.maintain(db, {
        checkpointIntervalMs: 60_000,
        databasePath: dbPath,
      });
      if (registrationOrder === "after") {
        expect(pragma("wal_autocheckpoint")).toBe(16 * 1024);
        expect(clock.armedAtMs).toBe(11_000);
        registerWorker();
      }
      expect(pragma("wal_autocheckpoint")).toBe(0);
      expect(clock.armedAtMs).toBe(61_000);

      await clock.advanceBy(50_000);
      expect(requests).toEqual([]);
      expect(clock.armedAtMs).toBe(61_000);
      await clock.advanceBy(10_000);
      expect(requests).toEqual([512]);
      expect(clock.armedAtMs).toBe(121_000);

      const prepare = vi.spyOn(db, "prepare");
      const exec = vi.spyOn(db, "exec");
      await cancelSqliteWalWriteAdmission(db);
      expect(cancelled).toBe(1);
      await maintenance.stop();
      expect(maintenance.close()).toBe(false);
      expect(prepare).not.toHaveBeenCalled();
      expect(exec).not.toHaveBeenCalled();
      prepare.mockRestore();
      exec.mockRestore();
      expect(pragma("wal_autocheckpoint")).toBe(0);
      expect(clock.armedAtMs).toBeNull();
    },
  );

  it("joins admitted maintenance before native close and refuses subsequent wakes", async () => {
    vi.useFakeTimers();
    const { db } = createDatabase();
    const maintenance = resources.maintain(db, { checkpointIntervalMs: 100 });
    const gate = createEnteredGate();
    resources.retain(gate.release);
    const execute = vi.fn(async () => {
      await gate.wait();
      expect(db.isOpen).toBe(true);
      return undefined;
    });
    registerSqliteWalWorkerMaintenance(db, execute);
    vi.advanceTimersByTime(100);
    await gate.entered;
    const closed = vi.fn();
    const closing = maintenance.stop().then(() => {
      maintenance.close();
      db.close();
      closed();
    });
    await Promise.resolve();
    expect(closed).not.toHaveBeenCalled();
    gate.release();
    await closing;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(closed).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("checkpoints on the maintenance tick and vacuums only on the periodic pass", async () => {
    vi.useFakeTimers();
    const { db, dbPath, pragma } = createDatabase();
    const freelistCount = () => pragma("freelist_count");
    // The periodic pass yields between vacuum units on real immediates that fake timers do not own.
    const settle = async () => {
      for (let index = 0; index < 64; index += 1) {
        await realImmediate();
      }
    };
    configureSqlitePreSchemaPragmas(db);
    const maintenance = resources.maintain(db, {
      busyTimeoutMs: 1_000,
      checkpointIntervalMs: 60_000,
      databasePath: dbPath,
    });
    db.exec(`CREATE TABLE payload (value BLOB NOT NULL);
      INSERT INTO payload VALUES (zeroblob(1048576));
      DELETE FROM payload;`);
    const freeBefore = freelistCount();
    expect(freeBefore).toBeGreaterThan(0);
    // Commits below the inline threshold leave every frame for the maintenance tick.
    expect(maintenance.health).toBeUndefined();

    await vi.advanceTimersByTimeAsync(10_000);
    await settle();

    const ticked = expectDefined(maintenance.health, "WAL tick health");
    expect(ticked).toMatchObject({ state: "complete", checkpointedFrames: ticked.logFrames });
    expect(ticked.checkpointedFrames).toBeGreaterThan(0);
    expect(freelistCount()).toBe(freeBefore);

    await vi.advanceTimersByTimeAsync(50_000);
    await settle();
    expect(freelistCount()).toBeLessThan(freeBefore);
  });
});
