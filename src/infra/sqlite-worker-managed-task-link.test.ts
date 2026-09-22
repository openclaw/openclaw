import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as activeTurns from "../acp/control-plane/active-turns.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { resetRuntimeTaskTestState } from "../plugins/runtime/runtime-task-test-harness.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { getDetachedTaskLifecycleRuntime } from "../tasks/detached-task-runtime.js";
import { createRunningTaskRunCore } from "../tasks/task-executor.js";
import { updateTask } from "../tasks/task-registry-mutation.js";
import { finalizeTaskRecordByRunId } from "../tasks/task-registry-record-api.js";
import { getTaskById, listTasksForFlowId } from "../tasks/task-registry.js";
import {
  runTaskRegistryMaintenance,
  configureTaskRegistryMaintenance,
  resetTaskRegistryMaintenanceRuntimeForTests,
} from "../tasks/task-registry.maintenance.js";
import {
  configureTaskRegistryRuntime,
  getTaskRegistryStore,
} from "../tasks/task-registry.store.js";
import { upsertTaskWithDeliveryStateToSqlite } from "../tasks/task-registry.store.sqlite.js";
import { setDetachedTaskLifecycleRuntime } from "../tasks/task-runtime.test-helpers.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { emitAgentEvent } from "./agent-events.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import type { SqliteWorkerOperations, SqliteWorkerStore } from "./sqlite-worker-contract.js";
import * as workerStore from "./sqlite-worker-store.js";

const ownerKey = "agent:main:managed-child-test";
const childSessionKey = "agent:main:managed-child";
const runId = "managed-child-run";
let state: OpenClawTestState;

beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "openclaw-managed-link-", applyEnv: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  await resetRuntimeTaskTestState();
  resetTaskRegistryMaintenanceRuntimeForTests();
  await state.cleanup();
});

function createBacking(overrides: Partial<Parameters<typeof createRunningTaskRunCore>[0]> = {}) {
  const task = createRunningTaskRunCore({
    runtime: "acp",
    ownerKey,
    scopeKind: "session",
    childSessionKey,
    runId,
    task: "Canonical child work",
    notifyPolicy: "silent",
    deliveryStatus: "pending",
    startedAt: 100,
    detail: {
      kind: "task_backing_instance",
      runtime: "acp",
      instanceId: "instance-1",
      generation: 1,
    },
    ...overrides,
  });
  expect(task?.parentFlowId).toBeTruthy();
  return task!;
}

function completeBacking() {
  return finalizeTaskRecordByRunId({
    runId,
    runtime: "acp",
    sessionKey: childSessionKey,
    status: "succeeded",
    endedAt: 200,
    terminalSummary: "Completed child work",
    suppressDelivery: true,
  });
}

describe("registered async managed child linkage", () => {
  it("keeps maintenance's post-recovery liveness decision in the task writer admission", async () => {
    const sessionKey = "synthetic-requester";
    const childKey = "synthetic-child";
    createBacking({ ownerKey: sessionKey, childSessionKey: childKey, startedAt: Date.now() });
    const runtime = createPluginRuntime();
    const managed = runtime.tasks.async.managedFlows.bindSession({ sessionKey });
    const legacy = runtime.tasks.managedFlows.bindSession({ sessionKey });
    const flow = await managed.createManaged({
      controllerId: "tests/recovery",
      goal: "Recover child metadata",
    });
    const input = {
      flowId: flow.flowId,
      runtime: "acp" as const,
      runId,
      childSessionKey: childKey,
      task: "Recovered child",
      status: "running" as const,
      startedAt: 100,
      notifyPolicy: "silent" as const,
    };
    const linked = legacy.runTask(input);
    if (!linked.created) {
      throw new Error(linked.reason);
    }
    expect(linked.task.agentId).toBeUndefined();
    const store = getTaskRegistryStore();
    const withMutation = store.withMutation;
    if (!withMutation) {
      throw new Error("Expected native task writer admission");
    }
    let custody = 0;
    configureTaskRegistryRuntime({
      store: {
        ...store,
        withMutation: <T>(operation: () => T): T =>
          withMutation(() => {
            custody += 1;
            try {
              return operation();
            } finally {
              custody -= 1;
            }
          }),
      },
    });
    let recovered = false;
    const livenessAdmissions: boolean[] = [];
    configureTaskRegistryMaintenance({ runtimeAuthoritative: true });
    vi.spyOn(activeTurns, "isAcpTurnActive").mockImplementation(() => {
      if (recovered) {
        livenessAdmissions.push(custody > 0);
      }
      return recovered;
    });
    setDetachedTaskLifecycleRuntime({
      ...getDetachedTaskLifecycleRuntime(),
      tryRecoverTaskBeforeMarkLost: async ({ taskId }) => {
        if (taskId === linked.task.taskId) {
          expect(custody).toBe(0);
          expect(
            await managed.runTask({ ...input, agentId: "main", sourceId: "recovered-source" }),
          ).toMatchObject({ created: true, task: { taskId, agentId: "main" } });
          recovered = true;
        }
        return { recovered: false };
      },
    });
    expect(await runTaskRegistryMaintenance()).toMatchObject({ reconciled: 0, pruned: 0 });
    expect(livenessAdmissions).toEqual([true]);
    expect(getTaskById(linked.task.taskId)).toMatchObject({
      status: "running",
      sourceId: "recovered-source",
      agentId: "main",
    });
  });

  it.each([4, 8])("keeps scoped reconciliation linear for %s independent links", async (count) => {
    const managed = createPluginRuntime().tasks.async.managedFlows.bindSession({
      sessionKey: ownerKey,
    });
    const flow = await managed.createManaged({
      controllerId: "tests/concurrent-links",
      goal: "Independent child links",
    });
    const commands = new Map<string, number>();
    const original = workerStore.runSqliteWorkerStoreOperation;
    vi.spyOn(workerStore, "runSqliteWorkerStoreOperation").mockImplementation(
      <Operations extends SqliteWorkerOperations, T>(
        store: SqliteWorkerStore<Operations>,
        operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
        stateContext?: Parameters<typeof workerStore.runSqliteWorkerStoreOperation>[2],
        assertCurrent?: Parameters<typeof workerStore.runSqliteWorkerStoreOperation>[3],
      ) =>
        original(
          store,
          (scope) =>
            operation({
              execute: (command, options) => {
                const kind = String(command.type);
                commands.set(kind, (commands.get(kind) ?? 0) + 1);
                return scope.execute(command, options);
              },
            }),
          stateContext,
          assertCurrent,
        ),
    );
    const results = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        managed.runTask({
          flowId: flow.flowId,
          runtime: "subagent",
          runId: `independent-${index}`,
          task: `Independent ${index}`,
          notifyPolicy: "silent",
        }),
      ),
    );
    expect(results.every((result) => result.created)).toBe(true);
    expect(listTasksForFlowId(flow.flowId)).toHaveLength(count);
    console.log("Managed link worker commands", { count, commands: Object.fromEntries(commands) });
    expect(commands.get("flows.runTask")).toBe(count);
    expect(commands.get("tasks.mutationSnapshot")).toBeLessThanOrEqual(count * 2);
  });

  it("persists an unbacked link without warmed main-thread SQLite and reopens it", async () => {
    const runtime = createPluginRuntime();
    const managed = runtime.tasks.async.managedFlows.bindSession({ sessionKey: ownerKey });
    const flow = await managed.createManaged({
      controllerId: "tests/link",
      goal: "Track external work",
    });
    await runtime.tasks.async.runs.bindSession({ sessionKey: ownerKey }).list();
    const native = requireNodeSqlite();
    for (const method of ["prepare", "exec"] as const) {
      vi.spyOn(native.DatabaseSync.prototype, method).mockImplementation(() => {
        throw new Error("Unexpected warmed main-thread SQLite");
      });
    }
    for (const method of ["iterate", "get", "all", "run"] as const) {
      vi.spyOn(native.StatementSync.prototype, method).mockImplementation(() => {
        throw new Error("Unexpected warmed main-thread SQLite");
      });
    }
    const result = await managed.runTask({
      flowId: flow.flowId,
      runtime: "subagent",
      runId: "external-work",
      task: "Existing external work",
      notifyPolicy: "silent",
    });
    expect(result).toMatchObject({
      created: true,
      flow: { revision: 0 },
      task: { parentFlowId: flow.flowId, runId: "external-work", status: "queued" },
    });
    vi.restoreAllMocks();
    if (!result.created) {
      throw new Error(result.reason);
    }
    expect(getTaskById(result.task.taskId)).toMatchObject({ task: "Existing external work" });
    await closeOpenClawStateDatabaseAsync();
    expect(
      await runtime.tasks.async.runs.bindSession({ sessionKey: ownerKey }).get(result.task.taskId),
    ).toMatchObject({ id: result.task.taskId });
  });

  it("uses persisted exact-match order for async reuse while retaining legacy insertion order", async () => {
    const runtime = createPluginRuntime();
    const managed = runtime.tasks.async.managedFlows.bindSession({ sessionKey: ownerKey });
    const legacy = runtime.tasks.managedFlows.bindSession({ sessionKey: ownerKey });
    const flow = await managed.createManaged({
      controllerId: "tests/order",
      goal: "Duplicate ordering",
    });
    const ids = [
      "ffffffff-ffff-4fff-8fff-ffffffffffff",
      "00000000-0000-4000-8000-000000000001",
    ] as const;
    const uuid = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValueOnce(ids[0])
      .mockReturnValueOnce(ids[1]);
    try {
      for (const label of ["first", "second"]) {
        expect(
          legacy.runTask({
            flowId: flow.flowId,
            runtime: "subagent",
            runId,
            label,
            task: label,
            status: "running",
            startedAt: 100,
            notifyPolicy: "silent",
          }).created,
        ).toBe(true);
      }
    } finally {
      uuid.mockRestore();
    }
    expect(updateTask(ids[1], { label: "first", task: "first" })).toBeTruthy();
    const input = {
      flowId: flow.flowId,
      runtime: "subagent" as const,
      runId,
      label: "first",
      task: "first",
      notifyPolicy: "silent" as const,
    };
    expect(legacy.runTask(input)).toMatchObject({ created: true, task: { taskId: ids[0] } });
    expect(await managed.runTask(input)).toMatchObject({ created: true, task: { taskId: ids[1] } });
    expect(listTasksForFlowId(flow.flowId)).toHaveLength(2);
    expect(legacy.runTask(input)).toMatchObject({ created: true, task: { taskId: ids[0] } });
  });

  it("refuses a new active link after canonical completion but keeps terminal metadata reuse", async () => {
    createBacking();
    const runtime = createPluginRuntime();
    const managed = runtime.tasks.async.managedFlows.bindSession({ sessionKey: ownerKey });
    const before = await managed.createManaged({
      controllerId: "tests/terminal",
      goal: "Linked before completion",
    });
    const input = {
      runtime: "acp" as const,
      runId,
      childSessionKey,
      task: "Child work",
      status: "running" as const,
      notifyPolicy: "silent" as const,
    };
    const linked = await managed.runTask({ ...input, flowId: before.flowId });
    expect(linked.created).toBe(true);
    if (!linked.created) {
      throw new Error(linked.reason);
    }
    expect(completeBacking().map((task) => task.taskId)).toContain(linked.task.taskId);
    const after = await managed.createManaged({
      controllerId: "tests/terminal",
      goal: "Completed before link",
    });
    expect(await managed.runTask({ ...input, flowId: after.flowId })).toMatchObject({
      created: false,
      reason: "Task backing ownership could not be verified.",
    });
    expect(listTasksForFlowId(after.flowId)).toEqual([]);
    expect(
      await managed.runTask({
        ...input,
        flowId: before.flowId,
        task: "Updated metadata",
        preferMetadata: true,
      }),
    ).toMatchObject({
      created: true,
      task: {
        taskId: linked.task.taskId,
        status: "succeeded",
        endedAt: 200,
        task: "Updated metadata",
      },
    });
  });

  it.each(["record", "event"] as const)(
    "includes a committed worker link in %s finalization before its receipt is delivered",
    async (completion) => {
      createBacking();
      const runtime = createPluginRuntime();
      const managed = runtime.tasks.async.managedFlows.bindSession({ sessionKey: ownerKey });
      const flow = await managed.createManaged({
        controllerId: "tests/ordering",
        goal: "Completion after committed link",
      });
      const committed = createDeferredCore();
      const release = createDeferredCore();
      const original = workerStore.runSqliteWorkerStoreOperation;
      let held = false;
      vi.spyOn(workerStore, "runSqliteWorkerStoreOperation").mockImplementation(
        <Operations extends SqliteWorkerOperations, T>(
          store: SqliteWorkerStore<Operations>,
          operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
          stateContext?: Parameters<typeof workerStore.runSqliteWorkerStoreOperation>[2],
          assertCurrent?: Parameters<typeof workerStore.runSqliteWorkerStoreOperation>[3],
        ) =>
          original(
            store,
            (scope) =>
              operation({
                execute: async (command, options) => {
                  const result = await scope.execute(command, options);
                  if (!held && command.type === "flows.runTask") {
                    held = true;
                    committed.resolve();
                    await release.promise;
                  }
                  return result;
                },
              }),
            stateContext,
            assertCurrent,
          ),
      );
      const onEvent = vi.fn();
      configureTaskRegistryRuntime({ observers: { onEvent } });
      const pending = managed.runTask({
        flowId: flow.flowId,
        runtime: "acp",
        runId,
        childSessionKey,
        task: "Child work",
        status: "running",
        startedAt: 100,
        notifyPolicy: "silent",
      });
      try {
        await committed.promise;
        if (completion === "record") {
          const completed = completeBacking();
          expect(completed.filter((task) => task.parentFlowId === flow.flowId)).toHaveLength(1);
        } else {
          emitAgentEvent({
            runId,
            sessionKey: childSessionKey,
            stream: "lifecycle",
            data: { phase: "end", endedAt: 200 },
          });
        }
        onEvent.mockClear();
        release.resolve();
        const receipt = await pending;
        expect(receipt).toMatchObject({ created: true, task: { status: "running" } });
        expect(listTasksForFlowId(flow.flowId)).toMatchObject([
          { status: "succeeded", endedAt: 200 },
        ]);
        expect(onEvent).not.toHaveBeenCalled();
        await closeOpenClawStateDatabaseAsync();
        expect(
          await runtime.tasks.async.flows.bindSession({ sessionKey: ownerKey }).get(flow.flowId),
        ).toMatchObject({ tasks: [{ status: "succeeded" }] });
      } finally {
        release.resolve();
        await pending;
      }
    },
  );

  it("preserves the separately committed requester origin when a later metadata write fails", async () => {
    const runtime = createPluginRuntime();
    const origin = { channel: "telegram", to: "synthetic-chat" };
    const managed = runtime.tasks.async.managedFlows.bindSession({
      sessionKey: ownerKey,
      requesterOrigin: origin,
    });
    const flow = await managed.createManaged({
      controllerId: "tests/metadata",
      goal: "Preserve merge commits",
    });
    const taskId = "existing-child";
    upsertTaskWithDeliveryStateToSqlite({
      task: {
        taskId,
        runtime: "acp",
        requesterSessionKey: ownerKey,
        ownerKey,
        scopeKind: "session",
        parentFlowId: flow.flowId,
        runId,
        task: "Original metadata",
        status: "running",
        deliveryStatus: "delivered",
        notifyPolicy: "silent",
        createdAt: 100,
        agentId: "main",
        sourceId: "original-source",
      },
      deliveryState: { taskId, lastNotifiedEventAt: 150 },
    });
    const db = openOpenClawStateDatabase().db;
    db.exec(
      "CREATE TRIGGER reject_task_metadata BEFORE UPDATE ON task_runs BEGIN SELECT RAISE(ABORT, 'synthetic task update failure'); END",
    );
    const input = {
      flowId: flow.flowId,
      runtime: "acp" as const,
      runId,
      task: "Updated metadata",
      label: "Updated label",
      preferMetadata: true,
      agentId: "other",
      sourceId: "other-source",
      notifyPolicy: "silent" as const,
    };
    try {
      await expect(managed.runTask(input)).rejects.toThrow("synthetic task update failure");
      const snapshot = getTaskRegistryStore().loadSnapshot();
      expect(snapshot.deliveryStates.get(taskId)).toMatchObject({
        requesterOrigin: origin,
        lastNotifiedEventAt: 150,
      });
      expect(snapshot.tasks.get(taskId)).toMatchObject({
        task: "Original metadata",
        deliveryStatus: "delivered",
        agentId: "main",
        sourceId: "original-source",
      });
    } finally {
      db.exec("DROP TRIGGER reject_task_metadata");
    }
    expect(await managed.runTask(input)).toMatchObject({
      created: true,
      task: {
        taskId,
        task: "Updated metadata",
        label: "Updated label",
        deliveryStatus: "delivered",
        agentId: "main",
        sourceId: "original-source",
      },
    });
    expect(listTasksForFlowId(flow.flowId)).toHaveLength(1);
    expect(await managed.get(flow.flowId)).toMatchObject({ revision: 0 });
  });
});
