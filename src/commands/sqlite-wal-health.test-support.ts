import type { SqliteWalHealth } from "../infra/sqlite-wal.js";

export function createSqliteWalHealth(overrides: Partial<SqliteWalHealth> = {}): SqliteWalHealth {
  return {
    state: "blocked",
    observedAtMs: 1_800_000,
    walBytes: 128 * 1024 * 1024,
    databaseBytes: 32 * 1024 * 1024,
    logFrames: 4000,
    checkpointedFrames: 100,
    lastCompletedAtMs: null,
    consecutiveBlocked: 2,
    warning: true,
    ...overrides,
  };
}
