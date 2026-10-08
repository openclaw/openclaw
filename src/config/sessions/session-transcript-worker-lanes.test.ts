import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../../infra/sqlite-handle-lifecycle.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import type {
  WorkerTaskOptions,
  WorkerTaskPoolOptions,
} from "../../infra/worker-task-pool.types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  historyLane,
  maintenanceLane,
  projectionLane,
  rotateDatabaseWorkers,
  withSessionHistoryWorkerReadCandidates,
} from "./session-transcript-worker-resources.js";
import {
  isSessionHistoryWorkerCold,
  prewarmSessionHistoryWorker,
  retainSessionHistoryWorkerDatabase,
  runSessionBranchSummaryWorkerRequest,
  withSessionHistoryWorkerDatabase,
} from "./session-transcript-worker-runtime.js";
import type { SessionHistoryWorkerDatabase } from "./session-transcript-worker.types.js";

type Resource = { close: () => Promise<void>; agentId?: string; revoke: () => void };
const observed = vi.hoisted(() => ({
  explicitSqliteCloseReleasesNativeResources: true,
  setTimeout: vi.spyOn(globalThis, "setTimeout"),
  clearTimeout: vi.spyOn(globalThis, "clearTimeout"),
  run: vi.fn<(input: unknown, options: WorkerTaskOptions<unknown>) => Promise<unknown>>(),
  // Import-time pools are drained even when a name filter skips every test.
  rotate: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  closeResources: vi.fn<(key?: string) => Promise<void>>().mockResolvedValue(undefined),
  unregister: vi.fn<() => void>(),
  resources: [] as Resource[],
  replaceWorkers: [] as Array<() => () => Promise<void>>,
}));

vi.mock("../../infra/bun-sqlite-library.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/bun-sqlite-library.js")>()),
  ensureSqliteLibrarySelected: () => ({ source: "runtime" }),
  captureSqliteWorkerClosePolicy: () => observed.explicitSqliteCloseReleasesNativeResources,
  getSqliteRuntimeCapabilities: () => ({
    explicitSqliteCloseReleasesNativeResources: observed.explicitSqliteCloseReleasesNativeResources,
    reason: "test policy",
  }),
}));

vi.mock("node:diagnostics_channel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:diagnostics_channel")>();
  const pressure = actual.channel(Symbol("session-transcript-worker-lanes"));
  return {
    ...actual,
    channel: (name: string | symbol) =>
      name === "openclaw.memory.critical" ? pressure : actual.channel(name),
  };
});

vi.mock("../../infra/worker-task-pool.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/worker-task-pool.js")>()),
  createOwnedWorkerTaskPool: (poolOptions: WorkerTaskPoolOptions<unknown>) => {
    let worker: ReturnType<NonNullable<typeof poolOptions.prepareWorker>> | undefined;
    const retiring = new Set<NonNullable<typeof worker>>();
    let activeTasks = 0;
    observed.replaceWorkers.push(() => {
      const previous = worker;
      worker = poolOptions.prepareWorker?.();
      return async () => previous?.releaseResources?.();
    });
    return {
      async run(prepare: () => unknown, options: WorkerTaskOptions<unknown>) {
        activeTasks++;
        try {
          const preparedInput = prepare();
          worker ??= poolOptions.prepareWorker?.();
          return await observed.run(preparedInput, options);
        } finally {
          activeTasks--;
        }
      },
      getSnapshot: () => ({ activeTasks }),
      async rotate() {
        if (worker) {
          retiring.add(worker);
        }
        worker = undefined;
        const previous = [...retiring];
        try {
          await observed.rotate();
          for (const prepared of previous) {
            if (retiring.delete(prepared)) {
              await prepared.releaseResources?.();
            }
          }
        } catch (error) {
          void Promise.resolve(poolOptions.onRetirementFailure?.(error)).catch(() => undefined);
          throw error;
        }
      },
      closeResources: observed.closeResources,
    };
  },
}));
vi.mock("../../state/openclaw-agent-db-resources.js", () => ({
  matchesAgentDatabaseReadCandidatePath: (candidate: { path: string }, targetPath: string) =>
    candidate.path === targetPath,
  registerOpenClawAgentDatabaseReadCandidateResource: (resource: Resource) => {
    observed.resources.push(resource);
    return observed.unregister;
  },
  registerOpenClawAgentDatabaseAsyncResource: (resource: Resource) => {
    observed.resources.push(resource);
    return observed.unregister;
  },
}));
// The pure transport must not become the process-wide disk-scan singleton.
vi.mock("./disk-budget-runtime.js", () => ({
  measureSessionPhysicalDiskUsage: () => {
    throw new Error("Disk scans are forbidden in these pure controls");
  },
  drainSessionDiskBudgetWorkers: async () => {},
}));

let sequence = 0;
function input() {
  const database = { agentId: "main", path: `/synthetic/session-read-lanes-${++sequence}.sqlite` };
  return {
    database,
    scope: {
      agentId: "main",
      databaseAgentId: "main",
      sessionKey: "agent:main:lanes",
      storePath: database.path,
    },
  };
}

beforeEach(() => {
  observed.explicitSqliteCloseReleasesNativeResources = true;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  observed.setTimeout.mockImplementation(globalThis.setTimeout);
  observed.clearTimeout.mockImplementation(globalThis.clearTimeout);
  observed.run.mockReset();
  observed.rotate.mockReset().mockResolvedValue(undefined);
  observed.closeResources.mockReset().mockResolvedValue(undefined);
  observed.unregister.mockReset();
});
afterEach(async () => {
  observed.rotate.mockResolvedValue(undefined);
  observed.closeResources.mockResolvedValue(undefined);
  await Promise.all(observed.resources.splice(0).map((resource) => resource.close()));
  await Promise.all(
    [historyLane, projectionLane, maintenanceLane].map((lane) => rotateDatabaseWorkers(lane)),
  );
});
afterAll(() => {
  vi.useRealTimers();
  observed.setTimeout.mockRestore();
  observed.clearTimeout.mockRestore();
});

it("retains branch reads across ten-minute gaps in the maintenance owner", async () => {
  const { database, scope } = input();
  const request = {
    database,
    databaseIdentity: "synthetic-branch-owner",
    sessionKey: scope.sessionKey,
    sessionId: "branch-session",
  };
  const result = {
    status: "ok" as const,
    branches: [],
    generation: "branch-generation",
    maxSeq: 1,
  };
  const independentRead = vi
    .spyOn(WorkerTaskPool.prototype, "run")
    .mockResolvedValue({ ok: true, value: result });
  observed.run.mockResolvedValue({ ok: true, value: { kind: "branch-summaries", result } });
  const sequences = [historyLane.nativeSequence, projectionLane.nativeSequence];
  const before = maintenanceLane.nativeSequence;
  const signal = new AbortController().signal;
  try {
    await expect(runSessionBranchSummaryWorkerRequest(request, signal)).resolves.toEqual(result);
    expect(maintenanceLane.nativeSequence).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(observed.rotate).not.toHaveBeenCalled();

    await expect(runSessionBranchSummaryWorkerRequest(request, signal)).resolves.toEqual(result);
    expect(maintenanceLane.nativeSequence).toBe(before + 2);
    expect([historyLane.nativeSequence, projectionLane.nativeSequence]).toEqual(sequences);
    expect(independentRead).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SQLITE_IDLE_HANDLE_TTL_MS - 1);
    expect(observed.rotate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(observed.rotate).toHaveBeenCalledOnce();
    expect(isSessionHistoryWorkerCold(maintenanceLane)).toBe(true);
  } finally {
    independentRead.mockRestore();
  }
});

it.each([historyLane, maintenanceLane])(
  "dedupes $name prewarm custody without extending idle retirement",
  async (lane) => {
    await rotateDatabaseWorkers(lane);
    observed.rotate.mockClear();
    const request = input();
    const reply = createDeferredCore<unknown>();
    observed.run.mockReturnValueOnce(reply.promise);
    expect(isSessionHistoryWorkerCold(lane)).toBe(true);
    const first = prewarmSessionHistoryWorker(request.database, lane);
    const second = prewarmSessionHistoryWorker(request.database, lane);
    expect(observed.run).toHaveBeenCalledOnce();
    expect(lane.pending).toBe(1);
    expect(isSessionHistoryWorkerCold(lane)).toBe(false);
    reply.resolve({ ok: true, value: { kind: "prewarm" } });
    await Promise.all([first, second]);
    expect(lane.pending).toBe(0);
    expect(observed.unregister).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SQLITE_IDLE_HANDLE_TTL_MS - 1);
    await prewarmSessionHistoryWorker(request.database, lane);
    expect(observed.run).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(observed.rotate).toHaveBeenCalledOnce();
    expect(observed.unregister).toHaveBeenCalledOnce();
    expect(isSessionHistoryWorkerCold(lane)).toBe(true);

    observed.run.mockResolvedValue({ ok: true, value: { kind: "prewarm" } });
    await prewarmSessionHistoryWorker(request.database, lane);
    expect(observed.run).toHaveBeenCalledTimes(2);
  },
);

it.each([historyLane, maintenanceLane])(
  "settles failed and revoked $name prewarms without rejecting callers",
  async (lane) => {
    const request = input();
    observed.run.mockRejectedValueOnce(new Error("worker unavailable"));
    await expect(prewarmSessionHistoryWorker(request.database, lane)).resolves.toBeUndefined();
    expect(lane.pending).toBe(0);
    expect(observed.rotate).toHaveBeenCalledOnce();

    const reply = createDeferredCore<unknown>();
    observed.run.mockReturnValueOnce(reply.promise);
    const pending = prewarmSessionHistoryWorker(request.database, lane);
    const resource = observed.resources.at(-1)!;
    resource.revoke();
    reply.resolve({ ok: true, value: { kind: "prewarm" } });
    await expect(pending).resolves.toBeUndefined();
    await resource.close();
    expect(lane.pending).toBe(0);
    observed.run.mockResolvedValue({ ok: true, value: { kind: "prewarm" } });
    await prewarmSessionHistoryWorker(request.database, lane);
    expect(observed.run).toHaveBeenCalledTimes(3);
  },
);

it("joins only the matching lane prewarm and prepares its replacement after retirement", async () => {
  const request = input();
  const history = createDeferredCore<unknown>();
  const maintenance = createDeferredCore<unknown>();
  observed.run.mockReturnValueOnce(history.promise).mockReturnValueOnce(maintenance.promise);
  const preparingHistory = prewarmSessionHistoryWorker(request.database);
  const preparingMaintenance = prewarmSessionHistoryWorker(request.database, maintenanceLane);
  const joiningMaintenance = prewarmSessionHistoryWorker(request.database, maintenanceLane);
  try {
    expect(observed.run).toHaveBeenCalledTimes(2);
    expect(historyLane.pending).toBe(1);
    expect(maintenanceLane.pending).toBe(1);

    history.resolve({ ok: true, value: { kind: "prewarm" } });
    await preparingHistory;
    expect(historyLane.pending).toBe(0);
    expect(maintenanceLane.pending).toBe(1);
    maintenance.resolve({ ok: true, value: { kind: "prewarm" } });
    await Promise.all([preparingMaintenance, joiningMaintenance]);

    await rotateDatabaseWorkers(maintenanceLane);
    await prewarmSessionHistoryWorker(request.database);
    expect(observed.run).toHaveBeenCalledTimes(2);
    expect(isSessionHistoryWorkerCold(maintenanceLane)).toBe(true);
    observed.run.mockResolvedValue({ ok: true, value: { kind: "prewarm" } });
    await prewarmSessionHistoryWorker(request.database, maintenanceLane);
    expect(observed.run).toHaveBeenCalledTimes(3);
    expect(isSessionHistoryWorkerCold(maintenanceLane)).toBe(false);
  } finally {
    history.resolve({ ok: true, value: { kind: "prewarm" } });
    maintenance.resolve({ ok: true, value: { kind: "prewarm" } });
    await Promise.all([preparingHistory, preparingMaintenance, joiningMaintenance]);
  }
});

it("maintenance cleanup preserves foreground custody with an older sequence", async () => {
  const request = input();
  const candidates = [{ path: request.database.path, physicalPath: request.database.path }];
  observed.run.mockResolvedValue({ ok: true, value: false });
  // Independent queues can issue overlapping sequence numbers for the same store.
  maintenanceLane.nativeSequence = Math.max(
    maintenanceLane.nativeSequence,
    historyLane.nativeSequence,
  );
  await withSessionHistoryWorkerDatabase(request.database, (owner) =>
    owner.readEntryPresence(request.scope),
  );
  await withSessionHistoryWorkerReadCandidates(
    candidates,
    async (scope) => {
      observed.run.mockResolvedValueOnce({
        ok: true,
        value: {
          kind: "session-store-target",
          logicalAgentId: "main",
          sourcePath: request.database.path,
          database: request.database,
        },
      });
      await scope.readStoreTarget({
        agentId: "main",
        storePath: request.database.path,
        env: {},
        registeredDatabases: [],
      });
      await withSessionHistoryWorkerDatabase(
        request.database,
        (owner) => owner.readEntryPresence(request.scope),
        maintenanceLane,
      );
    },
    maintenanceLane,
  );
  expect(historyLane.nativeSequence).toBeLessThan(maintenanceLane.nativeSequence);
  expect(observed.unregister).toHaveBeenCalledOnce();
  const retained = observed.resources.find((resource) => resource.agentId === "main");
  assert(retained);
  await retained.close();
  expect(observed.rotate).not.toHaveBeenCalled();
  expect(observed.closeResources).toHaveBeenCalledTimes(3);
  expect(observed.unregister).toHaveBeenCalledTimes(2);
});

it("joins sibling reader cleanup for an eviction reported during discovery cleanup", async () => {
  const request = input();
  const target = {
    kind: "session-store-target" as const,
    logicalAgentId: "main",
    sourcePath: request.database.path,
    database: request.database,
  };
  const readerReply = createDeferredCore<unknown>();
  const cleanupStarted = createDeferredCore();
  const cleanupFinished = createDeferredCore();
  observed.run
    .mockResolvedValueOnce({ ok: true, value: target })
    .mockReturnValueOnce(readerReply.promise);
  observed.closeResources.mockImplementationOnce(async () => {
    cleanupStarted.resolve();
    await cleanupFinished.promise;
  });
  let missingRead: Promise<boolean> | undefined;
  const discovery = withSessionHistoryWorkerReadCandidates(
    [{ path: request.database.path, physicalPath: request.database.path }],
    async (owner) => {
      const selected = await owner.readStoreTarget({
        agentId: "main",
        storePath: request.database.path,
        env: {},
        registeredDatabases: [],
      });
      missingRead = withSessionHistoryWorkerDatabase(request.database, (reader) =>
        reader.readEntryPresence(request.scope),
      );
      return selected;
    },
  );
  try {
    await cleanupStarted.promise;
    readerReply.resolve({ ok: true, value: false, closedHistoryDatabase: request.database });
    await expect(missingRead).resolves.toBe(false);
    expect(observed.closeResources).toHaveBeenCalledTimes(2);
    cleanupFinished.resolve();
    await expect(discovery).resolves.toEqual(target);
    expect(observed.rotate).not.toHaveBeenCalled();
  } finally {
    readerReply.resolve({ ok: true, value: false, closedHistoryDatabase: request.database });
    cleanupFinished.resolve();
    await Promise.allSettled([discovery, missingRead]);
  }
});

it("joins unfinished reads before accepting a sibling eviction", async () => {
  const request = input();
  const preparing = createDeferredCore();
  const read = createDeferredCore<unknown>();
  const rotating = createDeferredCore();
  const retired = createDeferredCore();
  observed.run
    .mockImplementationOnce(() => {
      preparing.resolve();
      return read.promise;
    })
    .mockResolvedValueOnce({ ok: true, value: false, closedHistoryDatabase: request.database });
  observed.rotate.mockImplementationOnce(() => {
    rotating.resolve();
    return retired.promise;
  });
  const sibling = withSessionHistoryWorkerDatabase(request.database, (owner) =>
    owner.readEntryPresence(request.scope),
  );
  let evicting: Promise<boolean> | undefined;
  try {
    await preparing.promise;
    evicting = withSessionHistoryWorkerDatabase(request.database, (owner) =>
      owner.readEntryPresence(request.scope),
    );
    await Promise.race([
      rotating.promise,
      evicting.then(() => {
        throw new Error("Eviction released custody while a sibling read was still pending");
      }),
    ]);
    expect(observed.closeResources).not.toHaveBeenCalled();
    expect(observed.unregister).not.toHaveBeenCalled();
    read.resolve({ ok: true, value: false });
    await expect(sibling).resolves.toBe(false);
    expect(observed.unregister).not.toHaveBeenCalled();
    retired.resolve();
    await expect(evicting).resolves.toBe(false);
    expect(observed.unregister).toHaveBeenCalledOnce();
  } finally {
    read.resolve({ ok: true, value: false });
    retired.resolve();
    await Promise.allSettled([sibling, evicting]);
  }
});

it("joins full retirement if retained reader custody is revoked during discovery cleanup", async () => {
  const request = input();
  observed.run.mockResolvedValue({ ok: true, value: false });
  await withSessionHistoryWorkerDatabase(request.database, (owner) =>
    owner.readEntryPresence(request.scope),
  );
  const resource = observed.resources.find((entry) => entry.agentId === "main");
  assert(resource);
  const closing = createDeferredCore();
  const started = createDeferredCore();
  const retiring = createDeferredCore();
  const retired = createDeferredCore();
  observed.closeResources.mockImplementationOnce(async () => {
    started.resolve();
    await closing.promise;
  });
  observed.run.mockResolvedValueOnce({
    ok: true,
    value: {
      kind: "session-store-target",
      logicalAgentId: "main",
      sourcePath: request.database.path,
      database: request.database,
    },
  });
  const discovery = withSessionHistoryWorkerReadCandidates(
    [{ path: request.database.path, physicalPath: request.database.path }],
    (owner) =>
      owner.readStoreTarget({
        agentId: "main",
        storePath: request.database.path,
        env: {},
        registeredDatabases: [],
      }),
  );
  const rejected = expect(discovery).rejects.toThrow("custody was revoked");
  try {
    await started.promise;
    observed.rotate.mockImplementationOnce(() => {
      retiring.resolve();
      return retired.promise;
    });
    resource.revoke();
    closing.resolve();
    let settled = false;
    void discovery.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await retiring.promise;
    expect(settled).toBe(false);
    retired.resolve();
    await rejected;
    expect(observed.rotate).toHaveBeenCalled();
  } finally {
    closing.resolve();
    retired.resolve();
    await discovery.catch(() => {});
  }
});

it.each([
  { pending: false, capable: false },
  { pending: false, capable: true },
  { pending: true, capable: false },
  { pending: true, capable: true },
])(
  "revokes readers and joins cleanup (pending=$pending, capable=$capable)",
  async ({ pending, capable }) => {
    observed.explicitSqliteCloseReleasesNativeResources = capable;
    const request = input();
    observed.run.mockResolvedValue({ ok: true, value: false });
    const owners: SessionHistoryWorkerDatabase[] = [];
    for (const lane of [historyLane, projectionLane, maintenanceLane]) {
      await withSessionHistoryWorkerDatabase(
        request.database,
        async (owner) => {
          await owner.readEntryPresence(request.scope);
          owners.push(owner);
        },
        lane,
      );
    }
    expect(observed.resources).toHaveLength(1);
    const resource = observed.resources[0]!;
    const retained = pending ? retainSessionHistoryWorkerDatabase(request.database) : undefined;
    const foreground = createDeferredCore();
    const projection = createDeferredCore();
    const maintenance = createDeferredCore();
    const cleanup = pending || !capable ? observed.rotate : observed.closeResources;
    cleanup
      .mockReturnValueOnce(foreground.promise)
      .mockReturnValueOnce(projection.promise)
      .mockReturnValueOnce(maintenance.promise);
    resource.revoke();
    retained?.release();
    for (const owner of owners) {
      expect(owner.assertCurrent).toThrow("revoked");
    }
    const closing = resource.close();
    expect(cleanup).toHaveBeenCalledTimes(3);
    foreground.resolve();
    await foreground.promise;
    expect(observed.unregister).not.toHaveBeenCalled();
    projection.resolve();
    await projection.promise;
    expect(observed.unregister).not.toHaveBeenCalled();
    maintenance.resolve();
    await closing;
    expect(observed.unregister).toHaveBeenCalledTimes(1);
  },
);

it("binds native-close policy to each worker generation before replies", async () => {
  const read = async (lane: typeof historyLane) => {
    const request = input();
    observed.run.mockResolvedValueOnce({ ok: true, value: false });
    await withSessionHistoryWorkerDatabase(
      request.database,
      (owner) => owner.readEntryPresence(request.scope),
      lane,
    );
    const resource = observed.resources.at(-1);
    assert(resource?.agentId);
    return resource;
  };
  observed.explicitSqliteCloseReleasesNativeResources = false;
  const early = await read(historyLane);
  observed.explicitSqliteCloseReleasesNativeResources = true;
  const otherLane = await read(maintenanceLane);
  // A completed host decision cannot upgrade a worker born before admission.
  await early.close();
  expect(observed.rotate).toHaveBeenCalledOnce();
  await otherLane.close();
  expect(observed.closeResources).toHaveBeenCalledOnce();

  const predecessor = await read(historyLane);
  const releasePredecessor = observed.replaceWorkers[0]!();
  // Replacement captures its own policy without waiting for a task result.
  await predecessor.close();
  expect(observed.closeResources).toHaveBeenCalledTimes(2);
  const successor = await read(historyLane);
  await releasePredecessor();
  await successor.close();
  expect(observed.closeResources).toHaveBeenCalledTimes(3);
  expect(observed.rotate).toHaveBeenCalledOnce();
});

it("requires every live worker to support native close", async () => {
  const request = input();
  observed.explicitSqliteCloseReleasesNativeResources = false;
  observed.run.mockResolvedValue({ ok: true, value: false });
  await withSessionHistoryWorkerDatabase(request.database, (owner) =>
    owner.readEntryPresence(request.scope),
  );
  observed.explicitSqliteCloseReleasesNativeResources = true;
  const releaseOlder = observed.replaceWorkers[0]!();
  try {
    await observed.resources[0]!.close();
    expect(observed.rotate).toHaveBeenCalledOnce();
    expect(observed.closeResources).not.toHaveBeenCalled();
  } finally {
    await releaseOlder();
  }
});

it.each([false, true])("retains reads dispatched after cleanup (capable=%s)", async (capable) => {
  observed.explicitSqliteCloseReleasesNativeResources = capable;
  const request = input();
  observed.run.mockResolvedValue({ ok: true, value: false });
  const read = () =>
    withSessionHistoryWorkerDatabase(request.database, (owner) =>
      owner.readEntryPresence(request.scope),
    );
  await read();
  const resource = observed.resources.find((entry) => entry.agentId === "main");
  assert(resource);
  const receipt = createDeferredCore();
  const cleanup = capable ? observed.closeResources : observed.rotate;
  cleanup.mockReturnValueOnce(receipt.promise);
  const closing = resource.close();
  await read();
  receipt.resolve();
  await closing;
  expect(observed.unregister).not.toHaveBeenCalled();
  if (capable) {
    expect(observed.rotate).not.toHaveBeenCalled();
  }
  await resource.close();
  expect(observed.unregister).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledTimes(2);
});

it("releases pressure subscriptions after native settlement and rearms reopened lanes", async () => {
  const pressure = channel("openclaw.memory.critical");
  const request = input();
  observed.run.mockResolvedValue({
    ok: true,
    value: false,
  });
  await withSessionHistoryWorkerDatabase(request.database, async (owner) => {
    expect(pressure.hasSubscribers).toBe(true);
    expect(await owner.readEntryPresence(request.scope)).toBe(false);
  });
  // A task cannot release reader custody held by another worker in the pool.
  expect(observed.unregister).not.toHaveBeenCalled();
  const retirement = createDeferredCore();
  observed.rotate.mockReturnValueOnce(retirement.promise);
  pressure.publish(undefined);
  const rotation = historyLane.rotation;
  assert(rotation);
  try {
    expect(pressure.hasSubscribers).toBe(true);
  } finally {
    retirement.resolve();
    await rotation;
  }
  expect(observed.unregister).toHaveBeenCalledOnce();
  expect(pressure.hasSubscribers).toBe(false);

  observed.run.mockResolvedValueOnce({
    ok: true,
    value: {
      kind: "session-store-target",
      logicalAgentId: "main",
      sourcePath: request.database.path,
      database: request.database,
    },
  });
  await withSessionHistoryWorkerReadCandidates(
    [{ path: request.database.path, physicalPath: request.database.path }],
    (scope) =>
      scope.readStoreTarget({
        agentId: "main",
        storePath: request.database.path,
        env: {},
        registeredDatabases: [],
      }),
  );
  // Closing discovery readers also leaves their worker available for reuse.
  expect(pressure.hasSubscribers).toBe(true);
  const reopenedRetirement = createDeferredCore();
  // The pool resumes dispatch before the owner's rotation continuation runs.
  const successor = reopenedRetirement.promise.then(() =>
    withSessionHistoryWorkerDatabase(request.database, (owner) =>
      owner.readEntryPresence(request.scope),
    ),
  );
  observed.rotate.mockReturnValueOnce(reopenedRetirement.promise);
  pressure.publish(undefined);
  const reopenedRotation = historyLane.rotation;
  assert(reopenedRotation);
  reopenedRetirement.resolve();
  await Promise.all([reopenedRotation, successor]);
  // The older rotation must not retire a newly dispatched native sequence.
  expect(pressure.hasSubscribers).toBe(true);
  pressure.publish(undefined);
  await historyLane.rotation;
  expect(pressure.hasSubscribers).toBe(false);

  await withSessionHistoryWorkerDatabase(request.database, async () => {
    expect(pressure.hasSubscribers).toBe(true);
  });
  expect(pressure.hasSubscribers).toBe(false);
});
