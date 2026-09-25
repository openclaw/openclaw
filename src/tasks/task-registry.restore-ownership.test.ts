import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { hostname } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  createInMemoryTaskFlowRegistryStore,
  createInMemoryTaskRegistryStore,
} from "../test-utils/task-registry-store.js";
import { createTaskFlowForTask, getTaskFlowById } from "./task-flow-runtime-internal.js";
import { reloadTaskRegistryFromStoreAsync } from "./task-registry-state.js";
import { getTaskById } from "./task-registry.js";
import { configureTaskRegistryRuntime } from "./task-registry.store.js";
import { loadTaskRegistryStateFromSqlite } from "./task-registry.store.sqlite.js";
import { createTaskFixture } from "./task-registry.test-support.js";
import type { TaskExecutionOwner, TaskRecord } from "./task-registry.types.js";
import { bindTaskRunOwner } from "./task-run-owner.js";
import {
  configureTaskFlowRegistryRuntime,
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

const children = new Set<ChildProcess>();

afterEach(async () => {
  for (const child of children) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
  children.clear();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
});

function ownerFor(pid: number): TaskExecutionOwner {
  const startIdentity = getFileLockProcessStartTime(pid);
  if (startIdentity === null) {
    throw new Error("Fixture process identity unavailable");
  }
  return { host: hostname(), pid, startIdentity };
}

async function restoreFixture(
  executionOwner?: TaskExecutionOwner,
  overrides?: Partial<TaskRecord>,
) {
  const task: TaskRecord = {
    taskId: "task-restart-proof",
    runtime: "subagent",
    taskKind: "external-harness",
    runId: "harness:restart-proof",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    task: "Background restart proof",
    status: "running",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    createdAt: Date.now() - 60_000,
    ...(executionOwner ? { executionOwner } : {}),
    ...overrides,
  };
  const store = createInMemoryTaskRegistryStore({
    tasks: new Map([[task.taskId, task]]),
    deliveryStates: new Map(),
  });
  configureTaskRegistryRuntime({ store });
  await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
  return { task, store };
}

describe("task execution ownership on successor restore", () => {
  it("persists the current process identity when a live task owner binds", async () => {
    const { task, store } = await restoreFixture();
    const release = bindTaskRunOwner(task, async () => ({
      ok: false,
      error: "Unused cancellation",
    }));
    expect(store.loadSnapshot().tasks.get(task.taskId)?.executionOwner).toEqual(
      ownerFor(process.pid),
    );
    release();
    await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
    expect(getTaskById(task.taskId)?.status).toBe("running");
  });

  it("does not publish a terminal restore when persistence fails", async () => {
    const owner = ownerFor(process.pid);
    const { task, store } = await restoreFixture(owner);
    store.upsertTaskWithDeliveryState({
      task: { ...task, executionOwner: { ...owner, startIdentity: owner.startIdentity + 1 } },
    });
    configureTaskRegistryRuntime({
      store: {
        ...store,
        upsertTaskWithDeliveryState: () => {
          throw new Error("synthetic write failure");
        },
      },
    });
    await expect(
      reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext()),
    ).rejects.toThrow("synthetic write failure");
    expect(store.loadSnapshot().tasks.get(task.taskId)?.status).toBe("running");
    expect(() => getTaskById(task.taskId)).toThrow("synthetic write failure");
  });

  it("settles a dead childless execution after a timed-out drain before the successor drains", async () => {
    await withStateDirEnv("task-owner-restart-", async () => {
      resetTaskRegistryForTests({ persist: false });
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      children.add(child);
      await once(child, "spawn");
      if (!child.pid) {
        throw new Error("Fixture process did not start");
      }
      const task = createTaskFixture("subagent", {
        taskKind: "external-harness",
        runId: "harness:restart-proof",
        task: "Background restart proof",
        executionOwner: ownerFor(child.pid),
        notifyPolicy: "silent",
      });
      expect((await waitForGatewayActiveWork(0)).drained).toBe(false);
      expect(loadTaskRegistryStateFromSqlite().tasks.get(task.taskId)?.status).toBe("running");

      const exited = once(child, "exit");
      child.kill();
      await exited;
      children.delete(child);
      resetTaskRegistryForTests({ persist: false });
      await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());

      expect((await waitForGatewayActiveWork(0)).drained).toBe(true);
      expect(loadTaskRegistryStateFromSqlite().tasks.get(task.taskId)).toMatchObject({
        status: "cancelled",
        endedAt: expect.any(Number),
        error: "Task execution process exited before restart.",
        terminalSummary: "Task execution process exited before restart.",
      });
      expect(getTaskById(task.taskId)?.status).toBe("cancelled");
    });
  });

  it("settles a reused PID without treating the replacement process as its owner", async () => {
    const owner = ownerFor(process.pid);
    const { task } = await restoreFixture({ ...owner, startIdentity: owner.startIdentity + 1 });
    expect((await waitForGatewayActiveWork(0)).drained).toBe(true);
    expect(getTaskById(task.taskId)?.status).toBe("cancelled");
  });

  it("retries orphan settlement after the first restore's enclosing transaction rolls back", async () => {
    await withStateDirEnv("task-owner-restore-rollback-", async () => {
      resetTaskRegistryForTests({ persist: false });
      const owner = ownerFor(process.pid);
      const task = createTaskFixture("subagent", {
        runId: "harness:restore-rollback",
        task: "Restore an orphan after rollback",
        executionOwner: { ...owner, startIdentity: owner.startIdentity + 1 },
        notifyPolicy: "silent",
      });
      resetTaskRegistryForTests({ persist: false });

      const failure = new Error("Synthetic enclosing restore rollback");
      expect(() =>
        runOpenClawStateWriteTransaction(() => {
          expect(getTaskById(task.taskId)?.status).toBe("cancelled");
          expect(loadTaskRegistryStateFromSqlite().tasks.get(task.taskId)?.status).toBe(
            "cancelled",
          );
          throw failure;
        }),
      ).toThrow(failure);

      expect(loadTaskRegistryStateFromSqlite().tasks.get(task.taskId)?.status).toBe("running");
      expect(getTaskById(task.taskId)?.status).toBe("cancelled");
      expect(loadTaskRegistryStateFromSqlite().tasks.get(task.taskId)?.status).toBe("cancelled");
    });
  });

  it.each(["live", "legacy", "foreign-host"] as const)(
    "preserves %s ownership and the grace period",
    async (kind) => {
      const owner = kind === "legacy" ? undefined : ownerFor(process.pid);
      const { task, store } = await restoreFixture(
        kind === "foreign-host" && owner ? { ...owner, host: "other-host.invalid" } : owner,
      );
      configureTaskRegistryRuntime({
        store: {
          ...store,
          withMutation: () => {
            throw new Error("Read-only restore must not require write admission");
          },
        },
      });
      await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
      expect((await waitForGatewayActiveWork(0)).drained).toBe(false);
      expect(store.loadSnapshot().tasks.get(task.taskId)).toEqual(task);
      expect(getTaskById(task.taskId)?.endedAt).toBeUndefined();
    },
  );

  it("rechecks execution ownership after settlement admission", async () => {
    const liveOwner = ownerFor(process.pid);
    const { task, store } = await restoreFixture(liveOwner);
    store.upsertTaskWithDeliveryState({
      task: {
        ...task,
        executionOwner: { ...liveOwner, startIdentity: liveOwner.startIdentity + 1 },
      },
    });
    configureTaskRegistryRuntime({
      store: {
        ...store,
        withMutation: (operation) => {
          store.upsertTaskWithDeliveryState({ task });
          return operation();
        },
      },
    });
    await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
    expect(getTaskById(task.taskId)?.executionOwner).toEqual(liveOwner);
    expect(store.loadSnapshot().tasks.get(task.taskId)?.status).toBe("running");
    expect((await waitForGatewayActiveWork(0)).drained).toBe(false);
  });

  it.each(["running", "succeeded"] as const)(
    "preserves a newer %s task's flow when an older execution is orphaned",
    async (successorStatus) => {
      const owner = ownerFor(process.pid);
      const { task } = await restoreFixture(owner);
      const now = Date.now();
      const successor: TaskRecord = {
        ...task,
        taskId: "task-newer-execution",
        runId: "harness:newer-execution",
        task: "Newer task result",
        status: successorStatus,
        createdAt: now - 1_000,
        ...(successorStatus === "succeeded" ? { endedAt: now } : {}),
      };
      const flowStore = createInMemoryTaskFlowRegistryStore();
      configureTaskFlowRegistryRuntime({ store: flowStore });
      const flow = createTaskFlowForTask({ task: successor });
      if (!flow) {
        throw new Error("Fixture flow was not created");
      }
      const older: TaskRecord = {
        ...task,
        parentFlowId: flow.flowId,
        executionOwner: { ...owner, startIdentity: owner.startIdentity + 1 },
      };
      configureTaskRegistryRuntime({
        store: createInMemoryTaskRegistryStore(
          {
            tasks: new Map([
              [older.taskId, older],
              [successor.taskId, { ...successor, parentFlowId: flow.flowId }],
            ]),
            deliveryStates: new Map(),
          },
          flowStore,
        ),
      });
      await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
      expect(getTaskById(older.taskId)?.status).toBe("cancelled");
      expect(getTaskById(successor.taskId)?.status).toBe(successorStatus);
      const restoredFlow = getTaskFlowById(flow.flowId);
      expect(restoredFlow?.status).toBe(successorStatus);
      expect(restoredFlow?.goal).toBe(successor.task);
      expect(restoredFlow?.endedAt).toBe(successor.endedAt);
    },
  );

  it.each(["queued", "succeeded"] as const)(
    "does not settle an already %s record",
    async (status) => {
      const owner = ownerFor(process.pid);
      const { task } = await restoreFixture(
        { ...owner, startIdentity: owner.startIdentity + 1 },
        { status },
      );
      expect(getTaskById(task.taskId)?.status).toBe(status);
    },
  );
});
