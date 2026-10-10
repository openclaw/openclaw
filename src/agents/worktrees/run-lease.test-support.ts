import "./run-lease.js";

type WorktreeRunLeaseTesting = {
  drainPendingCleanupsForTest(): Promise<void>;
  resetForTest(): void;
};

type WorktreeRunLeaseTestApi = {
  testing: WorktreeRunLeaseTesting;
};

function getTestApi(): WorktreeRunLeaseTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.worktreeRunLeaseTestApi")
  ] as WorktreeRunLeaseTestApi;
}

export const testing = getTestApi().testing;
