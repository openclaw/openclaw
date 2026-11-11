import fs from "node:fs";
import type { Worker, WorkerOptions } from "node:worker_threads";
import { beforeEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as backoff from "../../infra/backoff.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import * as leaseStore from "../../state/openclaw-state-lease-store.js";
import {
  withWorktreeAllocationLease,
  withWorktreeMutationLease,
  type WorktreeAllocationGuard,
} from "./allocation.js";
import {
  WorktreeCapacityContentionError,
  WORKTREE_CAPACITY_RESERVATION_SCOPE,
} from "./capacity.js";
import { useInProcessWorktreeCapacityTransport } from "./capacity.test-support.js";
import { useWorktreeStateRoots } from "./state-fixture.test-support.js";

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

const tempDirs = useWorktreeStateRoots(() => {
  heartbeatWorkers.onCreate = undefined;
});

const GiB = 1024 ** 3;
let root: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  root = tempDirs.make("worktree-allocation-");
  env = { ...process.env, OPENCLAW_STATE_DIR: root };
});
const allocate = <T>(body: (guard: WorktreeAllocationGuard) => Promise<T>) =>
  withWorktreeAllocationLease({ env }, body);
const reserve = (guard: WorktreeAllocationGuard, bytes = GiB, retained = false) =>
  guard.requireDiskSpace([{ path: root, bytes }], "fixture", retained);

function mockDiskSpace() {
  vi.spyOn(fs, "statfsSync").mockReturnValue(
    Object.assign(fs.statfsSync(root), {
      bsize: 4096,
      bavail: (6 * GiB) / 4096,
      bfree: (6 * GiB) / 4096,
    }),
  );
}

it("joins a dependency installation that holds allocation beyond ten minutes", async () => {
  const entered = createDeferred();
  const release = createDeferred();
  const holder = allocate(async () => {
    entered.resolve();
    await release.promise;
  });
  await awaitGateBeforeSettlement(entered.promise, holder, "installer did not acquire allocation");
  const now = performance.now.bind(performance);
  let elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now() + elapsed);
  // Advance only contention's clock; the real lease and heartbeat remain live.
  vi.spyOn(backoff, "sleepWithAbort")
    .mockImplementationOnce(async () => {
      elapsed = 12 * 60_000;
    })
    .mockImplementationOnce(async () => {
      release.resolve();
      await holder;
    });
  try {
    await expect(allocate(async () => "joined")).resolves.toBe("joined");
  } finally {
    release.resolve();
    await holder;
  }
});

it("retains disk debt until native settlement after lease loss", async ({ signal }) => {
  mockDiskSpace();
  const worker = createDeferred<Worker>();
  heartbeatWorkers.onCreate = worker.resolve;
  const entered = createDeferred();
  const release = createDeferred();
  const operation = withWorktreeMutationLease({ env, id: "held-removal" }, async (guard) => {
    await reserve(guard, 3 * GiB, true);
    entered.resolve();
    await release.promise;
  });
  const outcome = operation.catch((error: unknown) => error);
  const admitCreation = () => allocate(async (guard) => reserve(guard));
  try {
    await withinTest(
      awaitGateBeforeSettlement(entered.promise, operation, "snapshot was not admitted"),
      signal,
    );
    // Losing/replacing the operation lease cannot retire debt held by unfinished native work.
    runOpenClawStateWriteTransaction(
      ({ db }) =>
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<Pick<DB, "state_leases">>(db)
            .deleteFrom("state_leases")
            .where("scope", "=", "core:managed-worktrees:mutation")
            .where("lease_key", "=", "held-removal"),
        ),
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
  mockDiskSpace();
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
  await expect(allocate(async (guard) => reserve(guard, 3 * GiB, true))).rejects.toMatchObject({
    message: expect.stringContaining("disk reservation cleanup failed"),
    cause: failure,
  });
  fault.mockRestore();
  await expect(allocate(async (guard) => reserve(guard))).resolves.toBeUndefined();
});

it("keeps allocation renewal off the parent thread and fences the body on heartbeat loss", async () => {
  const spawned = createDeferred<Worker>();
  heartbeatWorkers.onCreate = vi.fn(spawned.resolve);
  // Advance the parent's renewal interval without changing the worker's wall clock.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  await expect(
    allocate(async (guard) => {
      expect(heartbeatWorkers.onCreate).toHaveBeenCalledOnce();
      const worker = await spawned.promise;
      const sql = observeHostDataSql();
      expect(() => guard.commitGuard?.()).not.toThrow();
      expect(() => guard.rollbackGuard()).not.toThrow();
      expect(guard.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(sql.queries.filter((query) => /update\s+"?state_leases"?/i.test(query))).toEqual([]);
      await worker.terminate();
      const lost = expect.objectContaining({ code: "OPENCLAW_STATE_LEASE_LOST" });
      expect(() => guard.commitGuard?.()).toThrowError(lost);
      expect(() => guard.rollbackGuard()).toThrowError(lost);
      await expect(reserve(guard, 0)).rejects.toThrowError(lost);
      expect(guard.signal).toMatchObject({ aborted: true, reason: lost });
      sql.restore();
    }),
  ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
});
