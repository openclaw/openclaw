import type { Worker, WorkerOptions } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { withWorktreeAllocationLease } from "./allocation.js";

const heartbeatWorkers = vi.hoisted(() => ({
  onCreate: undefined as ((worker: Worker) => void) | undefined,
}));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  const [{ runtimeProcessEntrypoints }, { resolveRuntimeWorkerUrl }] = await Promise.all([
    import("../../infra/runtime-process-entrypoints.js"),
    import("../../infra/runtime-worker-url.js"),
  ]);
  const heartbeatUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.stateLeaseHeartbeat);
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options: WorkerOptions = {}) {
        super(filename, options);
        if (String(filename) === heartbeatUrl.href) {
          heartbeatWorkers.onCreate?.(this);
        }
      }
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    heartbeatWorkers.onCreate = undefined;
    vi.useRealTimers();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

it("keeps allocation renewal off the parent thread and fences the body on heartbeat loss", async () => {
  const env = { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("worktree-allocation-") };
  const spawned = new Promise<Worker>((resolve) => {
    heartbeatWorkers.onCreate = vi.fn(resolve);
  });
  // Advance the parent's renewal interval without changing the worker's wall clock.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  await expect(
    withWorktreeAllocationLease({ env }, async (guard) => {
      expect(heartbeatWorkers.onCreate).toHaveBeenCalledOnce();
      const worker = await spawned;
      const sql = observeHostDataSql();
      try {
        expect(() => guard.commitGuard?.()).not.toThrow();
        expect(() => guard.rollbackGuard()).not.toThrow();
        expect(guard.signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(sql.queries.filter((query) => /update\s+"?state_leases"?/i.test(query))).toEqual([]);

        await worker.terminate();
        const lost = expect.objectContaining({ code: "OPENCLAW_STATE_LEASE_LOST" });
        expect(() => guard.commitGuard?.()).toThrowError(lost);
        expect(() => guard.rollbackGuard()).toThrowError(lost);
        expect(guard.signal?.aborted).toBe(true);
        expect(guard.signal?.reason).toEqual(lost);
      } finally {
        sql.restore();
      }
    }),
  ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
});
