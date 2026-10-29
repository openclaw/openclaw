import fs from "node:fs";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  sqliteMaintenanceFixture,
  sqliteSchedulerClock,
} from "./sqlite-maintenance-fixture.test-support.js";
import { configureSqlitePreSchemaPragmas, configureSqliteWalMaintenance } from "./sqlite-wal.js";

const resources = sqliteMaintenanceFixture();

function fixture(options: Parameters<typeof configureSqliteWalMaintenance>[1], preSchema = false) {
  const pathname = resources.file();
  const writer = resources.open(pathname);
  if (preSchema) {
    configureSqlitePreSchemaPragmas(writer);
  }
  const maintenance = resources.maintain(writer, {
    checkpointIntervalMs: 0,
    ...options,
    databasePath: pathname,
  });
  return { pathname, writer, maintenance };
}

it("keeps checkpoint-only reclamation nonblocking without changing the connection lock policy", () => {
  const { writer, maintenance, pathname } = fixture({
    autoCheckpointPages: 0,
    busyTimeoutMs: 5_000,
  });
  const peer = resources.open(pathname);
  writer.exec("CREATE TABLE payload (value TEXT); INSERT INTO payload VALUES ('before');");
  peer.exec("BEGIN; SELECT * FROM payload;");
  writer.exec("INSERT INTO payload VALUES ('after');");
  const admission = vi.fn();
  const observation = observeHostDataSql();
  try {
    const blocked = maintenance.reclaimFreePages({
      checkpointMode: "PASSIVE",
      maxPages: 0,
      beforeMutation: admission,
    });
    expect(blocked).toMatchObject({
      checkpoint: { health: { state: "blocked" } },
      vacuumPasses: 0,
    });
    expect(admission).toHaveBeenCalledOnce();
    expect(observation.queries.filter((sql) => /busy_timeout/i.test(sql))).toEqual([]);
  } finally {
    observation.restore();
  }
  expect(writer.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(5_000);
  expect(peer.prepare("SELECT COUNT(*) AS count FROM payload").get()?.count).toBe(1);
  peer.exec("ROLLBACK; BEGIN IMMEDIATE;");
  expect(
    maintenance.reclaimFreePages({ checkpointMode: "PASSIVE", maxPages: 0 }).checkpoint?.health
      .state,
  ).toBe("complete");
  peer.exec("ROLLBACK;");
  expect(() =>
    maintenance.reclaimFreePages({
      checkpointMode: "PASSIVE",
      maxPages: 0,
      beforeMutation: () => {
        throw new Error("revoked");
      },
    }),
  ).toThrow("revoked");
  expect(maintenance.health).toMatchObject({ state: "error", error: "revoked" });
  expect(writer.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(5_000);
  expect(writer.prepare("SELECT value FROM payload ORDER BY rowid").all()).toEqual([
    { value: "before" },
    { value: "after" },
  ]);
});

it("does not amplify a reader-held WAL on repeated periodic maintenance", async () => {
  const clock = sqliteSchedulerClock();
  const { writer, maintenance, pathname } = fixture(
    {
      autoCheckpointPages: 0,
      busyTimeoutMs: 50,
      checkpointIntervalMs: 100,
    },
    true,
  );
  const reader = resources.open(pathname, { readOnly: true });
  writer.exec(`CREATE TABLE payload (data BLOB);
      INSERT INTO payload VALUES (zeroblob(4194304));
      DELETE FROM payload;`);
  expect(maintenance.checkpoint()).toBe(true);
  reader.exec("BEGIN");
  reader.prepare("SELECT COUNT(*) FROM payload").get();
  writer.exec("INSERT INTO payload VALUES ('retained');");
  const freePages = () => Number(writer.prepare("PRAGMA freelist_count").get()?.freelist_count);
  const before = freePages();
  const walBytes = fs.statSync(`${pathname}-wal`).size;
  expect(before).toBeGreaterThan(512);
  for (let pass = 0; pass < 3; pass++) {
    await clock.advanceBy(100);
    expect(maintenance.health?.state).toBe("blocked");
    expect(freePages()).toBe(before);
    expect(fs.statSync(`${pathname}-wal`).size).toBe(walBytes);
  }
  expect(writer.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(50);
  reader.exec("ROLLBACK");
  await clock.advanceBy(100);
  expect(maintenance.health?.state).toBe("complete");
  expect(before - freePages()).toBeGreaterThan(0);
  expect(before - freePages()).toBeLessThanOrEqual(512);
  expect(maintenance.checkpoint()).toBe(true);
  expect(fs.statSync(`${pathname}-wal`).size).toBe(0);
  expect(writer.prepare("SELECT data FROM payload").get()?.data).toBe("retained");
});

it("reports bounded page progress and retains the native checkpoint outcome", () => {
  let admitted = true;
  const { writer: database, maintenance } = fixture(
    { runMaintenance: (op) => admitted && op() },
    true,
  );
  database.exec(`CREATE TABLE payload (data BLOB);
      INSERT INTO payload VALUES (zeroblob(4194304));
      DELETE FROM payload;`);
  const observed: string[] = [];
  const result = maintenance.reclaimFreePages({
    maxPages: 5,
    beforeMutation: () => observed.push(`before:${database.isTransaction}`),
    onCommit: () => observed.push(`commit:${database.isTransaction}`),
    afterCommit: () => observed.push(`settled:${database.isTransaction}`),
  });
  expect(observed).toEqual([
    "before:false",
    "before:true",
    "commit:true",
    "settled:false",
    "before:false",
  ]);
  expect(result).toMatchObject({
    checkpointCompleted: true,
    checkpoint: { health: { state: "complete", walBytes: 0 } },
    checkpointCalls: 2,
    checkpointIncomplete: 0,
    vacuumPasses: 1,
    vacuumPagesRequested: 5,
  });
  expect(result.freePagesBefore! - result.remainingFreePages!).toBeGreaterThan(0);
  expect(result.freePagesBefore! - result.remainingFreePages!).toBeLessThanOrEqual(5);
  admitted = false;
  expect(() => maintenance.reclaimFreePages()).toThrow("reclamation owner is unavailable");
});
