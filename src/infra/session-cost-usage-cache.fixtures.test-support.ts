import { expect } from "vitest";
import { prepareSessionCostUsageRefreshLock } from "./session-cost-usage-cache.sqlite.js";

export function createUsageCacheWrite(
  rollupId = "session.jsonl",
  value: string | Record<string, unknown> = '{"totalTokens":7}',
  updatedAt = 1,
  blob: Uint8Array | null = null,
) {
  return {
    rollupId,
    valueJson: new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)),
    blob,
    updatedAt,
  };
}

export function createUsagePartitionWrites(
  dates: readonly string[],
  value: Record<string, unknown>,
  byte: number,
) {
  return dates.map((date) => ({
    date,
    valueJson: JSON.stringify(value),
    blob: new Uint8Array([byte]),
  }));
}

export function disposableUsageLock(
  ...args: Parameters<typeof prepareSessionCostUsageRefreshLock>
) {
  const lock = prepareSessionCostUsageRefreshLock(...args);
  return Object.assign(lock, { [Symbol.asyncDispose]: lock.release });
}

export async function acquireUsageLock(
  ...args: Parameters<typeof prepareSessionCostUsageRefreshLock>
) {
  const lock = disposableUsageLock(...args);
  try {
    expect(await lock.acquire()).toBe(true);
    return lock;
  } catch (error) {
    await lock.release();
    throw error;
  }
}
