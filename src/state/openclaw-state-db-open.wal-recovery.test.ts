import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SqliteWalCheckpointSnapshot } from "../infra/sqlite-wal-checkpoint.js";
import { publishSqliteWalCheckpointObservation } from "../infra/sqlite-wal-checkpoint.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import { armOpenClawStateDatabaseWalRecovery } from "./openclaw-state-db-open.js";

// Worker threads own shared-state WAL maintenance chains, but the recovery
// registry and checkpoint listeners are per-thread global singletons. These
// observations stay local to the thread, so recovery must be armed locally.
const RECOVERY_SYMBOL = Symbol.for("openclaw.sqliteWalBlockedReaderRecovery");
const LISTENERS_SYMBOL = Symbol.for("openclaw.sqliteWalCheckpointListeners");
const ARMED_SYMBOL = Symbol.for("openclaw.openclawStateDatabaseWalRecoveryArmed");

function resetRecoveryState() {
  for (const symbol of [RECOVERY_SYMBOL, LISTENERS_SYMBOL, ARMED_SYMBOL]) {
    delete (globalThis as Record<PropertyKey, unknown>)[symbol];
  }
}

function blockedObservation(consecutiveBlocked: number): SqliteWalCheckpointSnapshot {
  return {
    health: {
      state: "blocked",
      observedAtMs: Date.now(),
      walBytes: 402_540_512,
      databaseBytes: 41_676_800,
      logFrames: 97_704,
      checkpointedFrames: 42,
      lastCompletedAtMs: Date.now() - 8 * 60 * 60_000,
      consecutiveBlocked,
      warning: true,
    },
    observedAtNs: process.hrtime.bigint(),
  };
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

describe("armOpenClawStateDatabaseWalRecovery", () => {
  it("recycles thread-local state readers once and only past the threshold", async () => {
    const recover = vi.fn();
    expect(armOpenClawStateDatabaseWalRecovery(recover)).toBe(true);
    // A second open on the same thread must not stack duplicate recoveries.
    expect(armOpenClawStateDatabaseWalRecovery(vi.fn())).toBe(false);
    await publishBlocked(11);
    expect(recover).not.toHaveBeenCalled();
    await publishBlocked(12);
    expect(recover).toHaveBeenCalledTimes(1);
    // The shared cooldown throttles repeat recoveries.
    await publishBlocked(2_897);
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it("keeps the reference-counted cache close safe when nothing is cached", async () => {
    expect(
      armOpenClawStateDatabaseWalRecovery(() => {
        openClawStateDatabaseCache.closeOpenClawStateDatabase({ checkpointMode: "PASSIVE" });
      }),
    ).toBe(true);
    await publishBlocked(12);
    expect(() => openClawStateDatabaseCache.closeOpenClawStateDatabase()).not.toThrow();
  });
});
