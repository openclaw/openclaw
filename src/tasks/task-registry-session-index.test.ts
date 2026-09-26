import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createNextAcpTaskBackingDetail } from "./task-backing-authority.js";
import { createAcpTaskBackingDetailForTest } from "./task-backing-authority.test-support.js";
import { createTaskFlowForTask } from "./task-flow-registry.js";
import { recordTaskActivityEvent } from "./task-registry-activity.js";
import { applyTaskRegistryMaintenanceRetention } from "./task-registry-maintenance-retention.js";
import { updateTask } from "./task-registry-mutation.js";
import { publishTaskRecordAfterAtomicStore } from "./task-registry-publication.js";
import {
  findTaskByRunId,
  getTaskById,
  hasActiveTaskForChildSessionKey,
  listTaskRecordPage,
  listTaskRecordsForOwnerTree,
  listTasksForFlowId,
  listTasksForRelatedSessionKey,
} from "./task-registry-query.js";
import { createTaskRecord, linkTaskToFlowById } from "./task-registry-record-api.js";
import {
  getTasksByRunId,
  reloadTaskRegistryFromStoreAsync,
  runTaskRegistryWorkerMutation,
} from "./task-registry-state.js";
import { configureTaskRegistryRuntime, getTaskRegistryStore } from "./task-registry.store.js";
import { upsertTaskWithDeliveryStateToSqlite } from "./task-registry.store.sqlite.js";
import type { TaskRecord } from "./task-registry.types.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
beforeEach(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
});
afterEach(async () => {
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  await state.cleanup();
});

function createTask(params: Partial<Parameters<typeof createTaskRecord>[0]>) {
  const task = createTaskRecord({
    runtime: "cli",
    scopeKind: "session",
    ownerKey: "agent:main:owner",
    requesterSessionKey: "agent:main:requester",
    childSessionKey: "agent:main:child",
    status: "running",
    deliveryStatus: "not_applicable",
    task: "Indexed session task",
    ...params,
  });
  if (!task) {
    throw new Error("task creation failed");
  }
  return task;
}

async function taskIds(params: Omit<Parameters<typeof listTaskRecordPage>[0], "offset" | "limit">) {
  const result = await listTaskRecordPage({ ...params, offset: 0, limit: 100 });
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.value.tasks.map((task) => task.taskId);
}

it("publishes requester membership through create, update, restore, atomic publication and delete", async () => {
  const task = createTask({});
  const originalKey = task.requesterSessionKey;
  expect(await taskIds({ sessionKey: originalKey })).toEqual([task.taskId]);
  expect(hasActiveTaskForChildSessionKey({ sessionKey: originalKey })).toBe(false);
  expect(hasActiveTaskForChildSessionKey({ sessionKey: task.childSessionKey! })).toBe(true);

  const store = getTaskRegistryStore();
  configureTaskRegistryRuntime({
    store: {
      ...store,
      upsertTaskWithDeliveryState: () => {
        throw new Error("fixture write rejected");
      },
    },
  });
  try {
    expect(updateTask(task.taskId, { requesterSessionKey: "agent:main:rejected" })).toBeNull();
    expect(await taskIds({ sessionKey: originalKey })).toEqual([task.taskId]);
    expect(await taskIds({ sessionKey: "agent:main:rejected" })).toEqual([]);
  } finally {
    configureTaskRegistryRuntime({ store });
  }

  const updated = updateTask(task.taskId, { requesterSessionKey: task.ownerKey });
  expect(updated).not.toBeNull();
  expect(await taskIds({ sessionKey: originalKey })).toEqual([]);
  expect(await taskIds({ sessionKey: task.ownerKey })).toEqual([task.taskId]);
  await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
  expect(listTasksForRelatedSessionKey(task.ownerKey).map((row) => row.taskId)).toEqual([
    task.taskId,
  ]);

  const published = {
    ...task,
    requesterSessionKey: "agent:main:published",
    status: "succeeded" as const,
    cleanupAfter: 0,
  };
  const deliveryState = store.loadSnapshot().deliveryStates.get(task.taskId);
  upsertTaskWithDeliveryStateToSqlite({
    task: published,
    ...(deliveryState ? { deliveryState } : {}),
  });
  publishTaskRecordAfterAtomicStore(published);
  expect(await taskIds({ sessionKey: published.requesterSessionKey })).toEqual([task.taskId]);
  expect(await taskIds({ sessionKey: task.ownerKey })).toEqual([task.taskId]);
  expect(
    await applyTaskRegistryMaintenanceRetention(published, Date.now(), new Set(), () => {}),
  ).toBe("pruned");
  await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
  for (const sessionKey of [
    originalKey,
    published.requesterSessionKey,
    task.ownerKey,
    task.childSessionKey!,
  ]) {
    expect(await taskIds({ sessionKey })).toEqual([]);
  }
});

it("keeps requester-only bare keys bound to their agent", async () => {
  const cfg = {
    session: { scope: "global" },
    agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
  } satisfies OpenClawConfig;
  const tasks = ["ops", "research"].map((requesterAgentId) =>
    createTask({ requesterSessionKey: "global", requesterAgentId }),
  );
  for (const [index, sessionAgentId] of ["ops", "research"].entries()) {
    expect(await taskIds({ cfg, sessionKey: "global", sessionAgentId })).toEqual([
      tasks[index]?.taskId,
    ]);
  }
  expect(
    await taskIds({ cfg, sessionKey: "global", sessionAgentId: "ops", agentId: "research" }),
  ).toEqual([]);
});

it("preserves owner-or-child ACP generation history when requester candidates are added", async () => {
  const key = "agent:main:watched";
  const records = [
    { childSessionKey: key, generation: 2 },
    { ownerKey: key, generation: 8 },
    { requesterSessionKey: key, generation: 100 },
    { generation: 200 },
  ].map(({ generation, ...keys }) => {
    const task = createTask({
      ...keys,
      runtime: "acp",
      runId: `run-${generation}`,
      detail: createAcpTaskBackingDetailForTest(`instance-${generation}`, generation),
    });
    const flow = createTaskFlowForTask({ task });
    if (!flow) {
      throw new Error("task flow creation failed");
    }
    expect(linkTaskToFlowById({ taskId: task.taskId, flowId: flow.flowId })).not.toBeNull();
    return task;
  });
  expect(new Set(await taskIds({ sessionKey: key }))).toEqual(
    new Set(records.slice(0, 3).map((task) => task.taskId)),
  );
  expect(
    createNextAcpTaskBackingDetail({ childSessionKey: key, instanceId: "next" }),
  ).toMatchObject({ generation: 9 });
  await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
  expect(
    createNextAcpTaskBackingDetail({ childSessionKey: key, instanceId: "after-restore" }),
  ).toMatchObject({ generation: 9 });
  const expired = expectDefined(
    updateTask(records[0]!.taskId, { status: "succeeded", cleanupAfter: 0 }),
    "expired child task",
  );
  expect(
    await applyTaskRegistryMaintenanceRetention(expired, Date.now(), new Set(), () => {}),
  ).toBe("pruned");
  expect(hasActiveTaskForChildSessionKey({ sessionKey: key })).toBe(false);
});

function createEqualTimeRunTasks() {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  try {
    return {
      first: createTask({ runId: "run-before-retarget", notifyPolicy: "silent" }),
      second: createTask({ runId: "run-shared", notifyPolicy: "silent" }),
    };
  } finally {
    clock.mockRestore();
  }
}

it("removes run lookup membership when a native update clears the run ID", () => {
  const task = createTask({ runId: "run-before-clear" });
  expect(updateTask(task.taskId, { runId: undefined })).not.toBeNull();
  expect(findTaskByRunId("run-before-clear")).toBeUndefined();
  expect(getTaskById(task.taskId)?.runId).toBeUndefined();
  expect(getTaskRegistryStore().loadSnapshot().tasks.get(task.taskId)?.runId).toBeUndefined();

  expect(updateTask(task.taskId, { runId: "run-before-empty" })).not.toBeNull();
  expect(updateTask(task.taskId, { runId: "" })).not.toBeNull();
  expect(findTaskByRunId("run-before-empty")).toBeUndefined();
  expect(getTaskById(task.taskId)).toBeDefined();
});

it.each(["native update", "store readback"] as const)(
  "preserves equal-time native duplicate selection after %s, publication, and deletion",
  async (writer) => {
    const { first, second } = createEqualTimeRunTasks();
    const next = { ...first, runId: "run-shared" };
    if (writer === "native update") {
      expect(updateTask(first.taskId, { runId: next.runId })).not.toBeNull();
    } else {
      const context = captureOpenClawStateWorkerContext();
      const store = getTaskRegistryStore();
      const scope = { taskId: first.taskId, runId: next.runId };
      await runTaskRegistryWorkerMutation(
        {
          admission: context.admission,
          scope,
          publicationRecords: () => new Map([[first.taskId, next]]),
        },
        async () => store.upsertTaskWithDeliveryState({ task: next }),
        () => store.loadMutationSnapshotAsync(context, scope),
      );
    }
    const expectedIds = [first.taskId, second.taskId];
    expect(getTasksByRunId("run-shared").map((task) => task.taskId)).toEqual(expectedIds);
    expect(findTaskByRunId("run-before-retarget")).toBeUndefined();
    expect(findTaskByRunId("run-shared")?.taskId).toBe(first.taskId);
    expect(createTask({ runId: "run-shared", notifyPolicy: "silent" }).taskId).toBe(first.taskId);

    expect(updateTask(first.taskId, { progressSummary: "Metadata-only update" })).not.toBeNull();
    const published = {
      ...expectDefined(getTaskById(first.taskId), "task before atomic publication"),
      progressSummary: "Committed metadata",
    };
    upsertTaskWithDeliveryStateToSqlite({ task: published });
    publishTaskRecordAfterAtomicStore(published);
    const unrelated = createTask({ runId: "run-unrelated", status: "succeeded", cleanupAfter: 0 });
    expect(
      await applyTaskRegistryMaintenanceRetention(unrelated, Date.now(), new Set(), () => {}),
    ).toBe("pruned");
    expect(getTasksByRunId("run-shared").map((task) => task.taskId)).toEqual(expectedIds);
    expect(findTaskByRunId("run-shared")?.taskId).toBe(first.taskId);

    await reloadTaskRegistryFromStoreAsync(captureOpenClawStateWorkerContext());
    // SQLite restoration orders equal-time rows by task ID, then rebuilds their indexes.
    expect(getTasksByRunId("run-shared").map((task) => task.taskId)).toEqual(
      expectedIds.toSorted(),
    );
  },
);

it.each(["native update", "atomic publication"] as const)(
  "indexes the row actually replaced after reentrant activity publication during %s",
  (writer) => {
    const task = createTask({ runId: "run-before-flush", notifyPolicy: "silent" });
    const completed = { ...task, status: "succeeded" as const, endedAt: Date.now() };
    const store = getTaskRegistryStore();
    let reentered = false;
    let observerUpdate: ReturnType<typeof updateTask> | undefined;
    recordTaskActivityEvent(task, {
      runId: task.runId!,
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Synthetic pending activity" },
    });
    configureTaskRegistryRuntime({
      observers: {
        onEvent(event) {
          if (
            !reentered &&
            event.kind === "upserted" &&
            event.task.taskId === task.taskId &&
            event.task.status === "running"
          ) {
            reentered = true;
            observerUpdate = updateTask(task.taskId, { runId: "run-from-observer" });
            if (writer === "atomic publication") {
              // The outer publisher resumes with this last committed record after the observer.
              store.upsertTaskWithDeliveryState({ task: completed });
            }
          }
        },
      },
    });
    if (writer === "native update") {
      expect(
        updateTask(task.taskId, { status: "succeeded", endedAt: completed.endedAt }),
      ).not.toBeNull();
    } else {
      store.upsertTaskWithDeliveryState({ task: completed });
      publishTaskRecordAfterAtomicStore(completed);
    }
    expect(reentered).toBe(true);
    expect(observerUpdate).toMatchObject({ runId: "run-from-observer" });
    expect(findTaskByRunId("run-from-observer")).toBeUndefined();
    expect(findTaskByRunId(task.runId!)?.taskId).toBe(task.taskId);
    expect(getTaskById(task.taskId)).toMatchObject({ runId: task.runId, status: "succeeded" });
    expect(store.loadSnapshot().tasks.get(task.taskId)).toMatchObject({
      runId: task.runId,
      status: "succeeded",
    });
  },
);

it("preserves run membership across rejected retention and enclosing update rollback", async () => {
  const { first, second } = createEqualTimeRunTasks();
  expect(updateTask(first.taskId, { runId: "run-shared" })).not.toBeNull();
  const expired = expectDefined(
    updateTask(first.taskId, { status: "succeeded", cleanupAfter: 0 }),
    "expired indexed task",
  );
  const expectedIds = [first.taskId, second.taskId];
  const store = getTaskRegistryStore();
  const before = store.loadSnapshot();
  const database = openOpenClawStateDatabase();
  const deleted: string[] = [];
  configureTaskRegistryRuntime({
    observers: {
      onEvent(event) {
        if (event.kind === "deleted") {
          deleted.push(event.taskId);
        }
      },
    },
  });
  database.db.exec(`
    CREATE TRIGGER task_index_reject_delete BEFORE DELETE ON task_runs
    BEGIN SELECT RAISE(ABORT, 'synthetic delete rejection'); END;
  `);
  try {
    expect(
      await applyTaskRegistryMaintenanceRetention(expired, Date.now(), new Set(), () => {}),
    ).toBeUndefined();
    expect(deleted).toEqual([]);
    expect(getTasksByRunId("run-shared").map((task) => task.taskId)).toEqual(expectedIds);
    expect(store.loadSnapshot()).toEqual(before);
  } finally {
    database.db.exec("DROP TRIGGER task_index_reject_delete");
  }

  const failure = new Error("Synthetic enclosing task transaction rollback");
  expect(() =>
    runOpenClawStateWriteTransaction(() => {
      expect(updateTask(first.taskId, { runId: "run-rolled-back" })).not.toBeNull();
      expect(updateTask(second.taskId, { runId: "second-rolled-back" })).not.toBeNull();
      throw failure;
    }),
  ).toThrow(failure);
  expect(findTaskByRunId("run-rolled-back")).toBeUndefined();
  expect(findTaskByRunId("second-rolled-back")).toBeUndefined();
  expect(getTasksByRunId("run-shared").map((task) => task.taskId)).toEqual(expectedIds);
  expect(findTaskByRunId("run-shared")?.taskId).toBe(first.taskId);
  expect(store.loadSnapshot()).toEqual(before);
});

it.each(["native update", "atomic publication"] as const)(
  "indexes published owner, session and flow keys after reentrant activity publication during %s",
  (writer) => {
    const flowHost = createTask({
      ownerKey: "agent:main:flow-host-owner",
      requesterSessionKey: "agent:main:flow-host-requester",
      childSessionKey: "agent:main:flow-host-child",
      notifyPolicy: "silent",
    });
    const observerFlow = createTaskFlowForTask({ task: flowHost });
    if (!observerFlow) {
      throw new Error("observer flow creation failed");
    }
    expect(
      linkTaskToFlowById({ taskId: flowHost.taskId, flowId: observerFlow.flowId }),
    ).not.toBeNull();
    const task = createTask({ runId: "run-session-index", notifyPolicy: "silent" });
    const ownFlow = createTaskFlowForTask({ task });
    if (!ownFlow) {
      throw new Error("task flow creation failed");
    }
    expect(linkTaskToFlowById({ taskId: task.taskId, flowId: ownFlow.flowId })).not.toBeNull();
    const linked = expectDefined(getTaskById(task.taskId), "linked task");
    const completed = { ...linked, status: "succeeded" as const, endedAt: Date.now() };
    const store = getTaskRegistryStore();
    let reentered = false;
    recordTaskActivityEvent(linked, {
      runId: linked.runId!,
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Synthetic pending activity" },
    });
    configureTaskRegistryRuntime({
      observers: {
        onEvent(event) {
          if (
            !reentered &&
            event.kind === "upserted" &&
            event.task.taskId === task.taskId &&
            event.task.status === "running"
          ) {
            reentered = true;
            updateTask(task.taskId, {
              ownerKey: "agent:main:observer-owner",
              childSessionKey: "agent:main:observer-child",
              parentFlowId: observerFlow.flowId,
            });
            if (writer === "atomic publication") {
              // The outer publisher resumes with this last committed record after the observer.
              store.upsertTaskWithDeliveryState({ task: completed });
            }
          }
        },
      },
    });
    if (writer === "native update") {
      expect(
        updateTask(task.taskId, { status: "succeeded", endedAt: completed.endedAt }),
      ).not.toBeNull();
    } else {
      store.upsertTaskWithDeliveryState({ task: completed });
      publishTaskRecordAfterAtomicStore(completed);
    }
    expect(reentered).toBe(true);
    expect(getTaskById(task.taskId)).toMatchObject({
      ownerKey: linked.ownerKey,
      childSessionKey: linked.childSessionKey,
      parentFlowId: ownFlow.flowId,
      status: "succeeded",
    });
    const taskIdsFor = (records: TaskRecord[]) => records.map((record) => record.taskId);
    expect({
      ownerTree: taskIdsFor(listTaskRecordsForOwnerTree(new Set([linked.ownerKey!]))),
      observerOwnerTree: taskIdsFor(
        listTaskRecordsForOwnerTree(new Set(["agent:main:observer-owner"])),
      ),
      relatedSession: taskIdsFor(listTasksForRelatedSessionKey(linked.childSessionKey!)),
      observerRelatedSession: taskIdsFor(
        listTasksForRelatedSessionKey("agent:main:observer-child"),
      ),
      ownFlow: taskIdsFor(listTasksForFlowId(ownFlow.flowId)),
      observerFlow: taskIdsFor(listTasksForFlowId(observerFlow.flowId)),
    }).toEqual({
      ownerTree: [task.taskId],
      observerOwnerTree: [],
      relatedSession: [task.taskId],
      observerRelatedSession: [],
      ownFlow: [task.taskId],
      observerFlow: [flowHost.taskId],
    });
  },
);
