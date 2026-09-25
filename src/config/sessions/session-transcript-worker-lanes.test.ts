import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkerTaskOptions } from "../../infra/worker-task-pool.types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  historyLane,
  maintenanceLane,
  withSessionHistoryWorkerReadCandidates,
} from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import type { SessionHistoryWorkerDatabase } from "./session-transcript-worker.types.js";

type Resource = { close: () => Promise<void>; agentId?: string; revoke: () => void };
const observed = vi.hoisted(() => ({
  run: vi.fn<(input: unknown, options: WorkerTaskOptions<unknown>) => Promise<unknown>>(),
  rotate: vi.fn<() => Promise<void>>(),
  unregister: vi.fn<() => void>(),
  resources: [] as Resource[],
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
  createOwnedWorkerTaskPool: () => ({
    run: (prepare: () => unknown, options: WorkerTaskOptions<unknown>) =>
      observed.run(prepare(), options),
    rotate: observed.rotate,
    closeResources: async () => {},
  }),
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
  observed.run.mockReset();
  observed.rotate.mockReset().mockResolvedValue(undefined);
  observed.unregister.mockReset();
});
afterEach(async () => {
  observed.rotate.mockResolvedValue(undefined);
  await Promise.all(observed.resources.splice(0).map((resource) => resource.close()));
});

it.runIf(!process.versions.bun)(
  "maintenance cleanup preserves foreground custody with an older sequence",
  async () => {
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
    expect(observed.unregister).toHaveBeenCalledTimes(1);
    const retained = observed.resources.find((resource) => resource.agentId === "main");
    assert(retained);
    await retained.close();
    expect(observed.rotate).toHaveBeenCalledTimes(1);
    expect(observed.unregister).toHaveBeenCalledTimes(2);
  },
);

it("revokes both reader lanes and joins both retirements through one database owner", async () => {
  const request = input();
  observed.run.mockResolvedValue({ ok: true, value: false });
  const owners: SessionHistoryWorkerDatabase[] = [];
  for (const lane of [historyLane, maintenanceLane]) {
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
  const foreground = createDeferredCore();
  const maintenance = createDeferredCore();
  observed.rotate.mockReturnValueOnce(foreground.promise).mockReturnValueOnce(maintenance.promise);
  resource.revoke();
  for (const owner of owners) {
    expect(owner.assertCurrent).toThrow("revoked");
  }
  const closing = resource.close();
  expect(observed.rotate).toHaveBeenCalledTimes(2);
  foreground.resolve();
  await foreground.promise;
  expect(observed.unregister).not.toHaveBeenCalled();
  maintenance.resolve();
  await closing;
  expect(observed.unregister).toHaveBeenCalledTimes(1);
});

it.runIf(!process.versions.bun)(
  "releases pressure subscriptions after native settlement and rearms reopened lanes",
  async () => {
    const pressure = channel("openclaw.memory.critical");
    const request = input();
    observed.run.mockResolvedValue({
      ok: true,
      value: false,
      closedHistoryDatabase: request.database,
    });
    await withSessionHistoryWorkerDatabase(request.database, async (owner) => {
      expect(pressure.hasSubscribers).toBe(true);
      expect(await owner.readEntryPresence(request.scope)).toBe(false);
    });
    // A missing read releases its database while its native worker stays warm.
    expect(observed.unregister).toHaveBeenCalledOnce();
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
  },
);
