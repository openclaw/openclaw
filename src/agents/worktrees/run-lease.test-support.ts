import type { unlockWorktree } from "./git-lock.js";
import type { releaseWorktreeRunLeaseRowAsync } from "./run-lease-store.js";
import "./run-lease.js";

type WorktreeRunLeaseTesting = {
  setProcessStartTimeResolverForTest(resolver: ((pid: number) => number | null) | null): void;
  setDeadPidResolverForTest(resolver: ((pid: number) => boolean) | null): void;
  setReleaseRowImplForTest(impl: typeof releaseWorktreeRunLeaseRowAsync | null): void;
  setUnlockImplForTest(impl: typeof unlockWorktree | null): void;
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
