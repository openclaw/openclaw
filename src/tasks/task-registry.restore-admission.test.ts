import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawStateDatabaseReadAdmission } from "../state/openclaw-state-db-async-lifecycle.js";
import * as databaseCache from "../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  createInMemoryTaskFlowRegistryStore,
  createInMemoryTaskRegistryStore,
} from "../test-utils/task-registry-store.js";
import * as executionOwner from "./task-execution-owner.js";
import { getTaskFlowById, reloadTaskFlowRegistryFromStoreAsync } from "./task-flow-registry.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import { getTaskById } from "./task-registry-query.js";
import {
  bumpTaskRegistryRevision,
  reloadTaskRegistryFromStoreAsync,
} from "./task-registry-state.js";
import { configureTaskRegistryRuntime } from "./task-registry.store.js";
import type { TaskRecord } from "./task-registry.types.js";
import {
  configureTaskFlowRegistryRuntime,
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

const root = "/controlled-registry-admission";
const id = "restored-record";
let generation = 0;
let retirement: Error;

beforeEach(() => {
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  generation = 0;
  retirement = new Error("snapshot admission retired");
  const identities = new Map<string, OpenClawStateDatabaseReadAdmission["identity"]>();
  vi.spyOn(databaseCache, "captureOpenClawStateDatabaseReadAdmission").mockImplementation(
    (databasePath) => {
      const identity = { key: `memory:${databasePath}`, canonicalPath: databasePath };
      const capturedGeneration = generation;
      identities.set(databasePath, identity);
      return {
        databasePath,
        identity,
        assertCurrent() {
          if (capturedGeneration !== generation) {
            throw retirement;
          }
        },
      };
    },
  );
  vi.spyOn(
    databaseCache.openClawStateDatabaseCache,
    "getKnownOpenClawStateDatabaseIdentity",
  ).mockImplementation((databasePath) => identities.get(databasePath));
});

afterEach(() => {
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function fixture(kind: "task" | "flow") {
  const events: string[] = [];
  let afterRead = () => {};
  let replace = (_label: string) => {};
  const loads: string[] = [];
  const configure = (label: string) => {
    if (kind === "task") {
      const task: TaskRecord = {
        taskId: id,
        runtime: "cli",
        requesterSessionKey: "agent:main:test",
        ownerKey: "agent:main:test",
        scopeKind: "session",
        task: label,
        status: "succeeded",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: 1,
        endedAt: 2,
      };
      const store = createInMemoryTaskRegistryStore({
        tasks: new Map([[id, task]]),
        deliveryStates: new Map(),
      });
      replace = (nextLabel) =>
        store.upsertTaskWithDeliveryState({ task: { ...task, task: nextLabel } });
      configureTaskRegistryRuntime({
        store: {
          ...store,
          loadSnapshot() {
            const snapshot = store.loadSnapshot();
            loads.push(snapshot.tasks.get(id)?.task ?? "missing");
            afterRead();
            return snapshot;
          },
        },
        observers: { onEvent: (event) => events.push(event.kind) },
      });
    } else {
      const flow: TaskFlowRecord = {
        flowId: id,
        syncMode: "managed",
        controllerId: "tests/restore-admission",
        ownerKey: "agent:main:test",
        goal: label,
        revision: 0,
        status: "queued",
        notifyPolicy: "silent",
        createdAt: 1,
        updatedAt: 1,
      };
      const store = createInMemoryTaskFlowRegistryStore({ flows: new Map([[id, flow]]) });
      replace = (nextLabel) => store.upsertFlow({ ...flow, goal: nextLabel });
      configureTaskFlowRegistryRuntime({
        store: {
          ...store,
          loadSnapshot() {
            const snapshot = store.loadSnapshot();
            loads.push(snapshot.flows.get(id)?.goal ?? "missing");
            afterRead();
            return snapshot;
          },
        },
        observers: { onEvent: (event) => events.push(event.kind) },
      });
    }
  };
  configure("old");
  return {
    events,
    loads,
    configure,
    replace: (label: string) => replace(label),
    read: () => (kind === "task" ? getTaskById(id)?.task : getTaskFlowById(id)?.goal),
    afterRead(callback: () => void) {
      afterRead = callback;
    },
    reload: () =>
      kind === "task"
        ? reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext())
        : reloadTaskFlowRegistryFromStoreAsync(captureOpenClawStateWorkerContext()),
  };
}

describe.each(["task", "flow"] as const)("synchronous %s restore admission", (kind) => {
  it("rereads once after admission changes without publishing the discarded snapshot", () => {
    const owner = fixture(kind);
    owner.afterRead(() => {
      owner.afterRead(() => {});
      owner.replace("fresh");
      generation += 1;
    });
    expect(owner.read()).toBe("fresh");
    expect(owner.loads).toEqual(["old", "fresh"]);
    expect(owner.events).toEqual(["restored"]);
    expect(owner.read()).toBe("fresh");
    expect(owner.loads).toEqual(["old", "fresh"]);
    expect(owner.events).toEqual(["restored"]);
  });

  it("propagates a second admission change and permits a later fresh read", () => {
    const owner = fixture(kind);
    owner.afterRead(() => {
      generation += 1;
    });
    expect(owner.read).toThrow(retirement);
    expect(owner.loads).toEqual(["old", "old"]);
    expect(owner.events).toEqual([]);
    owner.afterRead(() => {});
    owner.replace("fresh");
    expect(owner.read()).toBe("fresh");
    expect(owner.loads).toEqual(["old", "old", "fresh"]);
    expect(owner.events).toEqual(["restored"]);
  });

  it("preserves the actual read error after reacquiring admission", () => {
    const owner = fixture(kind);
    const failure = new Error("fresh snapshot read failed");
    owner.afterRead(() => {
      generation += 1;
      owner.afterRead(() => {
        throw failure;
      });
    });
    expect(owner.read).toThrow(expect.objectContaining({ cause: failure }));
    expect(owner.read).toThrow(expect.objectContaining({ cause: failure }));
    expect(owner.loads).toEqual(["old", "old"]);
    expect(owner.events).toEqual([]);
  });

  it.each(["store", "root"] as const)("discards a snapshot after its %s changes", (change) => {
    const owner = fixture(kind);
    owner.afterRead(() => {
      owner.afterRead(() => {});
      if (change === "root") {
        vi.stubEnv("OPENCLAW_STATE_DIR", `${root}-next`);
        owner.replace("fresh");
      } else {
        owner.configure("fresh");
      }
    });
    expect(owner.read).toThrow();
    expect(owner.events).toEqual([]);
    expect(owner.read()).toBe("fresh");
    expect(owner.loads).toEqual(["old", "fresh"]);
    expect(owner.events).toEqual(["restored"]);
  });

  it("preserves a newer synchronous restore reached through reload reentry", async () => {
    const owner = fixture(kind);
    let pending: Promise<void> | undefined;
    owner.afterRead(() => {
      owner.afterRead(() => {});
      owner.configure("newer");
      pending = owner.reload();
      expect(owner.read()).toBe("newer");
    });
    try {
      expect(owner.read).toThrow();
      expect(owner.events).toEqual(["restored"]);
      expect(owner.read()).toBe("newer");
      expect(owner.loads).toEqual(["old", "newer"]);
    } finally {
      await pending;
    }
  });

  it("keeps actual read failures sticky with their original cause", () => {
    const owner = fixture(kind);
    const failure = new Error("snapshot read failed");
    owner.afterRead(() => {
      throw failure;
    });
    expect(owner.read).toThrow(expect.objectContaining({ cause: failure }));
    expect(owner.read).toThrow(expect.objectContaining({ cause: failure }));
    expect(owner.loads).toEqual(["old"]);
    expect(owner.events).toEqual([]);
  });
});

describe("committed restore flow obligations", () => {
  it.each(["admission", "revision", "store", "root"] as const)(
    "repairs the captured store after post-settlement %s retirement",
    async (change) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const flowId = "settled-flow";
      const flowStore = createInMemoryTaskFlowRegistryStore({
        flows: new Map([
          [
            flowId,
            {
              flowId,
              syncMode: "task_mirrored",
              ownerKey: "agent:main:test",
              goal: "settled task",
              revision: 0,
              status: "running",
              notifyPolicy: "silent",
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        ]),
      });
      const task: TaskRecord = {
        taskId: id,
        runtime: "cli",
        requesterSessionKey: "agent:main:test",
        ownerKey: "agent:main:test",
        scopeKind: "session",
        task: "settled task",
        parentFlowId: flowId,
        status: "succeeded",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: 1,
        endedAt: 2,
      };
      const store = createInMemoryTaskRegistryStore(
        {
          tasks: new Map([[id, task]]),
          deliveryStates: new Map(),
        },
        flowStore,
      );
      const sync = vi.spyOn(store, "syncTaskFlowAsync");
      const events: string[] = [];
      configureTaskFlowRegistryRuntime({ store: flowStore });
      configureTaskRegistryRuntime({
        store,
        observers: { onEvent: (event) => events.push(event.kind) },
      });
      const context = captureOpenClawStateWorkerContext();
      // Model a returned committed result; this does not execute orphan or process-owner decisions.
      vi.spyOn(executionOwner, "restoreTaskExecutionSnapshot").mockImplementationOnce(
        (selected, read) => {
          const snapshot = read ? read() : selected.loadSnapshot();
          if (change === "admission") {
            generation += 1;
          }
          if (change === "revision") {
            bumpTaskRegistryRevision();
          }
          if (change === "store") {
            configureTaskRegistryRuntime({ store: createInMemoryTaskRegistryStore() });
          }
          if (change === "root") {
            vi.stubEnv("OPENCLAW_STATE_DIR", `${root}-next`);
          }
          return { snapshot, settledTasks: [task] };
        },
      );
      expect(() => getTaskById(id)).toThrow();
      expect(events).toEqual([]);
      expect(flowStore.loadSnapshot().flows.get(flowId)?.status).toBe("running");
      expect(getTaskById(id)?.status).toBe(change === "store" ? undefined : "succeeded");
      await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sync).toHaveBeenCalledTimes(1);
      expect(sync.mock.calls[0]?.[0].admission.databasePath).toBe(context.admission.databasePath);
      expect(sync.mock.calls[0]?.[0].environment).toEqual(context.environment);
      expect(flowStore.loadSnapshot().flows.get(flowId)).toMatchObject({
        status: "succeeded",
        revision: 1,
      });
    },
  );
});
