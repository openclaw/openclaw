import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSqliteWalBlockedReaderRecovery } from "./sqlite-wal-blocked-reader-recovery.js";
import type { SqliteWalCheckpointSnapshot, SqliteWalHealth } from "./sqlite-wal-checkpoint.js";
import { publishSqliteWalCheckpointObservation } from "./sqlite-wal-checkpoint.js";

const RECOVERY_SYMBOL = Symbol.for("openclaw.sqliteWalBlockedReaderRecovery");
const LISTENERS_SYMBOL = Symbol.for("openclaw.sqliteWalCheckpointListeners");

function resetRecoveryState() {
  delete (globalThis as Record<PropertyKey, unknown>)[RECOVERY_SYMBOL];
  delete (globalThis as Record<PropertyKey, unknown>)[LISTENERS_SYMBOL];
}

function blockedObservation(consecutiveBlocked: number): SqliteWalCheckpointSnapshot {
  const health: SqliteWalHealth = {
    state: "blocked",
    observedAtMs: Date.now(),
    walBytes: 117_749_632,
    databaseBytes: 37_740_544,
    logFrames: 28_703,
    checkpointedFrames: 129,
    lastCompletedAtMs: Date.now() - 4 * 60 * 60_000,
    consecutiveBlocked,
    warning: true,
  };
  return { health, observedAtNs: process.hrtime.bigint() };
}

async function publishBlocked(consecutiveBlocked: number): Promise<void> {
  publishSqliteWalCheckpointObservation(
    "F:\\.openclaw\\state\\openclaw.sqlite",
    blockedObservation(consecutiveBlocked),
  );
  // Recovery hooks run off the notification fan-out; a microtask flush is enough.
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(resetRecoveryState);
afterEach(resetRecoveryState);

describe("registerSqliteWalBlockedReaderRecovery", () => {
  it("recovers idle readers once a WAL stays blocked past the threshold", async () => {
    const recover = vi.fn();
    registerSqliteWalBlockedReaderRecovery(recover);
    await publishBlocked(11);
    expect(recover).not.toHaveBeenCalled();
    await publishBlocked(12);
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it("throttles repeat recoveries inside the cooldown window", async () => {
    const recover = vi.fn();
    registerSqliteWalBlockedReaderRecovery(recover);
    await publishBlocked(12);
    await publishBlocked(1_488);
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it("stops recovering after the hook unregisters", async () => {
    const recover = vi.fn();
    const unregister = registerSqliteWalBlockedReaderRecovery(recover);
    unregister();
    await publishBlocked(40);
    expect(recover).not.toHaveBeenCalled();
  });

  it("contains failing hooks so one owner cannot block another", async () => {
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const failing = registerSqliteWalBlockedReaderRecovery(() => {
      throw new Error("rotation refused");
    });
    const healthy = vi.fn();
    registerSqliteWalBlockedReaderRecovery(healthy);
    await publishBlocked(12);
    expect(healthy).toHaveBeenCalledTimes(1);
    failing();
    warning.mockRestore();
  });
});
