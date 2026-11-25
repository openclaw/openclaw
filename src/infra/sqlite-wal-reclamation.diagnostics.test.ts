import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { configureSqlitePreSchemaPragmas, configureSqliteWalMaintenance } from "./sqlite-wal.js";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (...args: Parameters<typeof actual.createSubsystemLogger>) => ({
      ...actual.createSubsystemLogger(...args),
      warn,
    }),
  };
});

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("keeps best-effort vacuum admission quiet while still reclaiming on the next pass", () => {
  const pathname = path.join(dirs.make("openclaw-wal-reclamation-diagnostics-"), "agent.sqlite");
  const writer = new DatabaseSync(pathname);
  configureSqlitePreSchemaPragmas(writer);
  const maintenance = configureSqliteWalMaintenance(writer, {
    autoCheckpointPages: 0,
    busyTimeoutMs: 0,
    checkpointIntervalMs: 0,
    databasePath: pathname,
  });
  const peer = new DatabaseSync(pathname);
  try {
    writer.exec(`CREATE TABLE payload (data BLOB);
      INSERT INTO payload VALUES (zeroblob(4194304));
      DELETE FROM payload;`);
    expect(maintenance.checkpoint()).toBe(true);

    // A peer write lock denies admission before the vacuum transaction starts. The
    // reclamation owner already treats that as a skipped pass, so nothing is reported.
    peer.exec("BEGIN IMMEDIATE");
    warn.mockClear();
    const skipped = maintenance.reclaimFreePages({ maxPages: 8 });
    expect(skipped.vacuumPasses).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    peer.exec("ROLLBACK");

    // Suppression is scoped to admission only: the next uncontended pass still
    // reclaims pages normally. Commit-step contention reporting is covered by
    // openclaw-state-lease-diagnostics.test.ts.
    warn.mockClear();
    const reclaimed = maintenance.reclaimFreePages({ maxPages: 8 });
    expect(reclaimed.vacuumPasses).toBe(1);
    expect(reclaimed.freePagesBefore! - reclaimed.remainingFreePages!).toBeGreaterThan(0);
    expect(warn).not.toHaveBeenCalled();
  } finally {
    if (peer.isTransaction) {
      peer.exec("ROLLBACK");
    }
    peer.close();
    maintenance.close();
    writer.close();
  }
});
