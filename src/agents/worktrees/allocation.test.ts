import fs from "node:fs";
import type { Worker, WorkerOptions } from "node:worker_threads";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import * as leaseStore from "../../state/openclaw-state-lease-store.js";
import { withWorktreeAllocationLease, withWorktreeMutationLease } from "./allocation.js";
import {
  WorktreeCapacityContentionError,
  WORKTREE_CAPACITY_RESERVATION_SCOPE,
} from "./capacity.js";
import { useInProcessWorktreeCapacityTransport } from "./capacity.test-support.js";

beforeEach(useInProcessWorktreeCapacityTransport);

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
    vi.restoreAllMocks();
    vi.useRealTimers();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

const GiB = 1024 ** 3;
function mockDiskSpace(root: string) {
  const stats = fs.statfsSync(root);
  vi.spyOn(fs, "statfsSync").mockReturnValue({
    type: stats.type,
    blocks: stats.blocks,
    files: stats.files,
    frsize: stats.frsize,
    ffree: stats.ffree,
    bsize: 4096,
    bavail: (6 * GiB) / 4096,
    bfree: (6 * GiB) / 4096,
  });
}

it("retains admitted bytes after lease loss until its native operation settles", async ({
  signal,
}) => {
  const root = tempDirs.make("worktree-capacity-debt-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: root };
  mockDiskSpace(root);
  const worker = createDeferred<Worker>();
  heartbeatWorkers.onCreate = worker.resolve;
  const entered = createDeferred();
  const release = createDeferred();
  const operation = withWorktreeMutationLease({ env, id: "held-removal" }, async (guard) => {
    await guard.requireDiskSpace([{ path: root, bytes: 3 * GiB }], "snapshot fixture", true);
    entered.resolve();
    await release.promise;
  });
  const outcome = operation.catch((error: unknown) => error);
  const admitCreation = () =>
    withWorktreeAllocationLease({ env }, async (guard) => {
      await guard.requireDiskSpace([{ path: root, bytes: GiB }], "creation fixture");
    });
  try {
    await withinTest(
      awaitGateBeforeSettlement(entered.promise, operation, "snapshot was not admitted"),
      signal,
    );
    // Losing/replacing the operation lease cannot retire debt held by unfinished native work.
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<Pick<DB, "state_leases">>(db)
            .deleteFrom("state_leases")
            .where("scope", "=", "core:managed-worktrees:mutation")
            .where("lease_key", "=", "held-removal"),
        );
      },
      { env },
    );
    await (await withinTest(worker.promise, signal)).terminate();
    await expect(withinTest(admitCreation(), signal)).rejects.toBeInstanceOf(
      WorktreeCapacityContentionError,
    );
  } finally {
    release.resolve();
    await outcome;
  }
  expect(await outcome).toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
  await expect(admitCreation()).resolves.toBeUndefined();
});

it("retries failed reservation cleanup before admitting later disk writes", async () => {
  const root = tempDirs.make("worktree-capacity-cleanup-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: root };
  mockDiskSpace(root);
  const release = leaseStore.releaseOpenClawStateLeaseInTransaction;
  const failure = new Error("injected reservation release failure");
  const fault = vi
    .spyOn(leaseStore, "releaseOpenClawStateLeaseInTransaction")
    .mockImplementation((database, identity) => {
      if (identity.scope === WORKTREE_CAPACITY_RESERVATION_SCOPE) {
        throw failure;
      }
      return release(database, identity);
    });
  await expect(
    withWorktreeAllocationLease({ env }, async (guard) => {
      await guard.requireDiskSpace([{ path: root, bytes: 3 * GiB }], "snapshot fixture", true);
    }),
  ).rejects.toMatchObject({
    message: expect.stringContaining("disk reservation cleanup failed"),
    cause: failure,
  });
  fault.mockRestore();
  await expect(
    withWorktreeAllocationLease({ env }, async (guard) => {
      await guard.requireDiskSpace([{ path: root, bytes: GiB }], "creation fixture");
    }),
  ).resolves.toBeUndefined();
});

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
        await expect(
          guard.requireDiskSpace([{ path: env.OPENCLAW_STATE_DIR, bytes: 0 }], "fixture"),
        ).rejects.toThrowError(lost);
        expect(guard.signal?.aborted).toBe(true);
        expect(guard.signal?.reason).toEqual(lost);
      } finally {
        sql.restore();
      }
    }),
  ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
});
