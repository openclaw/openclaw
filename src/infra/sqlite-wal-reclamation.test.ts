import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { configureSqlitePreSchemaPragmas, configureSqliteWalMaintenance } from "./sqlite-wal.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.useRealTimers());

it("does not amplify a reader-held WAL on repeated periodic maintenance", () => {
  vi.useFakeTimers();
  const pathname = path.join(dirs.make("openclaw-wal-reclamation-"), "agent.sqlite");
  const { DatabaseSync } = requireNodeSqlite();
  const writer = new DatabaseSync(pathname);
  configureSqlitePreSchemaPragmas(writer);
  const maintenance = configureSqliteWalMaintenance(writer, {
    autoCheckpointPages: 0,
    busyTimeoutMs: 50,
    checkpointIntervalMs: 100,
    databasePath: pathname,
  });
  const reader = new DatabaseSync(pathname, { readOnly: true });
  try {
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
      vi.advanceTimersByTime(100);
      expect(maintenance.health?.state).toBe("blocked");
      expect(freePages()).toBe(before);
      expect(fs.statSync(`${pathname}-wal`).size).toBe(walBytes);
    }
    expect(writer.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(50);
    reader.exec("ROLLBACK");
    vi.advanceTimersByTime(100);
    expect(maintenance.health?.state).toBe("complete");
    expect(before - freePages()).toBeGreaterThan(0);
    expect(before - freePages()).toBeLessThanOrEqual(512);
    expect(maintenance.checkpoint()).toBe(true);
    expect(fs.statSync(`${pathname}-wal`).size).toBe(0);
    expect(writer.prepare("SELECT data FROM payload").get()?.data).toBe("retained");
  } finally {
    if (reader.isTransaction) {
      reader.exec("ROLLBACK");
    }
    reader.close();
    maintenance.close();
    writer.close();
  }
});

it("reports bounded page progress and retains the native checkpoint outcome", () => {
  const pathname = path.join(dirs.make("openclaw-wal-reclamation-unit-"), "agent.sqlite");
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(pathname);
  configureSqlitePreSchemaPragmas(database);
  let admitted = true;
  const maintenance = configureSqliteWalMaintenance(database, {
    checkpointIntervalMs: 0,
    databasePath: pathname,
    runMaintenance: (operation) => admitted && operation(),
  });
  try {
    database.exec(`CREATE TABLE payload (data BLOB);
      INSERT INTO payload VALUES (zeroblob(4194304));
      DELETE FROM payload;`);
    const observed: string[] = [];
    const result = maintenance.reclaimFreePages({
      maxPages: 31,
      beforeMutation: () => observed.push(`before:${database.isTransaction}`),
      onCommit: () => observed.push(`commit:${database.isTransaction}`),
    });
    expect(observed).toEqual(["before:false", "before:true", "commit:true", "before:false"]);
    expect(result).toMatchObject({
      checkpointCompleted: true,
      checkpoint: { state: "complete", walBytes: 0 },
      checkpointCalls: 2,
      checkpointIncomplete: 0,
      vacuumPasses: 1,
      vacuumPagesRequested: 31,
    });
    expect(result.freePagesBefore! - result.remainingFreePages!).toBeGreaterThan(0);
    expect(result.freePagesBefore! - result.remainingFreePages!).toBeLessThanOrEqual(31);
    admitted = false;
    expect(() => maintenance.reclaimFreePages()).toThrow("reclamation owner is unavailable");
  } finally {
    maintenance.close();
    database.close();
  }
});
