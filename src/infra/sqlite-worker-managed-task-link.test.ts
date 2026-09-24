import assert from "node:assert/strict";
import "./sqlite-worker-managed-task-link.test-support.js";
import crypto from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import * as activeTurns from "../acp/control-plane/active-turns.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { getDetachedTaskLifecycleRuntime } from "../tasks/detached-task-runtime.js";
import { createRunningTaskRunCoreWithReceiptAsync } from "../tasks/task-executor-create.async.js";
import { captureTaskRegistryReadFence } from "../tasks/task-registry-listener-state.js";
import { updateTask } from "../tasks/task-registry-mutation.js";
import { finalizeTaskRecordByRunId } from "../tasks/task-registry-record-api.js";
import { tasks } from "../tasks/task-registry-state.js";
import { getTaskById, listTasksForFlowId } from "../tasks/task-registry.js";
import {
  runTaskRegistryMaintenance,
  configureTaskRegistryMaintenance,
} from "../tasks/task-registry.maintenance.js";
import {
  configureTaskRegistryRuntime,
  getTaskRegistryStore,
} from "../tasks/task-registry.store.js";
import { upsertTaskWithDeliveryStateToSqlite } from "../tasks/task-registry.store.sqlite.js";
import type { TaskRegistryObserverEvent } from "../tasks/task-registry.store.types.js";
import { setDetachedTaskLifecycleRuntime } from "../tasks/task-runtime.test-helpers.js";
import { forbidMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { emitAgentEvent } from "./agent-events.js";
import * as workerAdmission from "./sqlite-worker-operation-admission.js";
import { interceptTaskWorkerCommands } from "./sqlite-worker-task.test-support.js";

const {
  ownerKey,
  childSessionKey,
  runId,
  createBacking,
  holdTaskCreationCommand,
  holdTaskEventPublication,
} = await import("./sqlite-worker-managed-task-link.test-support.js");

const childInput = {
  runtime: "acp",
  runId,
  childSessionKey,
  task: "Child work",
  status: "running",
  notifyPolicy: "silent",
} as const;

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
    assert(withMutation, "Expected native task writer admission");
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
    const snapshots = vi.spyOn(getTaskRegistryStore(), "loadMutationSnapshotAsync");
    interceptTaskWorkerCommands((type, execute) => {
      const kind = String(type);
      commands.set(kind, (commands.get(kind) ?? 0) + 1);
      return execute();
    });
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
    expect(snapshots.mock.calls.length).toBeLessThanOrEqual(count * 2);
  });

  it("persists an unbacked link without warmed main-thread SQLite and reopens it", async () => {
    const runtime = createPluginRuntime();
    const managed = runtime.tasks.async.managedFlows.bindSession({ sessionKey: ownerKey });
    const flow = await managed.createManaged({
      controllerId: "tests/link",
      goal: "Track external work",
    });
    await runtime.tasks.async.runs.bindSession({ sessionKey: ownerKey }).list();
    forbidMainThreadSql("Unexpected warmed main-thread SQLite");
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
    const linked = await managed.runTask({ ...childInput, flowId: before.flowId });
    expect(linked.created).toBe(true);
    if (!linked.created) {
      throw new Error(linked.reason);
    }
    expect(completeBacking().map((task) => task.taskId)).toContain(linked.task.taskId);
    const after = await managed.createManaged({
      controllerId: "tests/terminal",
      goal: "Completed before link",
    });
    expect(await managed.runTask({ ...childInput, flowId: after.flowId })).toMatchObject({
      created: false,
      reason: "Task backing ownership could not be verified.",
    });
    expect(listTasksForFlowId(after.flowId)).toEqual([]);
    expect(
      await managed.runTask({
        ...childInput,
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

  it.each([
    { completion: "record", reuse: false },
    { completion: "event", reuse: false },
    { completion: "event", reuse: true },
  ] as const)(
    "includes a committed worker link in $completion finalization before its receipt (reuse: $reuse)",
    async ({ completion, reuse }) => {
      const backing = createBacking();
      const runtime = createPluginRuntime();
      const managed = runtime.tasks.async.managedFlows.bindSession({ sessionKey: ownerKey });
      const flow = await managed.createManaged({
        controllerId: "tests/ordering",
        goal: "Completion after committed link",
      });
      const reusedId = "preexisting-managed-link";
      if (reuse) {
        upsertTaskWithDeliveryStateToSqlite({
          task: {
            ...backing,
            taskId: reusedId,
            parentFlowId: flow.flowId,
            task: "Child work",
            detail: {
              kind: "task_backing_instance",
              runtime: "acp",
              instanceId: "instance-1",
              generation: 1,
              taskId: backing.taskId,
            },
          },
        });
      }
      const held = holdTaskCreationCommand("flows.runTask", "after commit");
      const backingPublication =
        completion === "event" && !reuse ? holdTaskEventPublication(backing.taskId) : undefined;
      const onEvent = vi.fn<(event: TaskRegistryObserverEvent) => void>();
      configureTaskRegistryRuntime({ observers: { onEvent } });
      const pending = managed.runTask({
        ...childInput,
        flowId: flow.flowId,
        startedAt: 100,
      });
      try {
        await held.ready;
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
        if (completion === "event" && !reuse) {
          // Hold the committed predecessor while native readback consumes its linked successor.
          await backingPublication?.ready;
        }
        onEvent.mockClear();
        held.release();
        const receipt = await pending;
        expect(receipt).toMatchObject({ created: true, task: { status: "running" } });
        if (!receipt.created) {
          throw new Error(receipt.reason);
        }
        if (reuse) {
          expect(receipt).toMatchObject({ task: { taskId: reusedId } });
        }
        expect(listTasksForFlowId(flow.flowId)).toMatchObject([
          { status: "succeeded", endedAt: 200 },
        ]);
        backingPublication?.release();
        // Durable readback can precede observers; finish accepted events before retiring admission.
        await captureTaskRegistryReadFence(captureOpenClawStateWorkerContext().admission);
        await closeOpenClawStateDatabaseAsync();
        if (completion === "record") {
          expect(onEvent).not.toHaveBeenCalled();
        } else {
          const updates = onEvent.mock.calls
            .map(([event]) => event)
            .filter((event) => event.kind === "upserted");
          for (const taskId of [backing.taskId, receipt.task.taskId]) {
            // Completion may supersede the initial running publication before readback.
            expect([
              [{ status: "succeeded", endedAt: 200 }],
              [
                { status: "running", endedAt: undefined },
                { status: "succeeded", endedAt: 200 },
              ],
            ]).toContainEqual(
              updates
                .filter((event) => event.task.taskId === taskId)
                .map((event) => ({ status: event.task.status, endedAt: event.task.endedAt })),
            );
          }
          // Each task's lifecycle is ordered; independent task publications can interleave.
          expect(
            updates
              .filter((event) => event.task.status === "succeeded")
              .map((event) => event.task.taskId)
              .toSorted(),
          ).toEqual([backing.taskId, receipt.task.taskId].toSorted());
        }
        expect(
          await runtime.tasks.async.flows.bindSession({ sessionKey: ownerKey }).get(flow.flowId),
        ).toMatchObject({ tasks: [{ status: "succeeded" }] });
      } finally {
        backingPublication?.release();
        held.release();
        await pending;
      }
    },
  );

  it("captures a physical successor tool event for its unpublished canonical managed link", async () => {
    const canonicalRunId = "accepted-subagent-run";
    const physicalRunId = "successor-subagent-run";
    const child = "agent:main:subagent:managed-successor";
    const canonical = createBacking({
      runtime: "subagent",
      runId: canonicalRunId,
      childSessionKey: child,
      detail: { kind: "task_backing_instance", runtime: "subagent", generation: 2 },
    });
    const entry = {
      runId: physicalRunId,
      taskRunId: canonicalRunId,
      childSessionKey: child,
      requesterSessionKey: ownerKey,
      requesterDisplayKey: ownerKey,
      task: "Physical successor work",
      cleanup: "keep" as const,
      createdAt: 100,
      generation: 2,
      execution: { status: "running" as const, startedAt: 100 },
    };
    const managed = createPluginRuntime().tasks.async.managedFlows.bindSession({
      sessionKey: ownerKey,
    });
    const flow = await managed.createManaged({
      controllerId: "tests/successor-link",
      goal: "Canonical successor link",
    });
    const held = holdTaskCreationCommand("flows.runTask", "after commit");
    subagentRuns.set(physicalRunId, entry);
    const pending = managed.runTask({
      ...childInput,
      flowId: flow.flowId,
      runtime: "subagent",
      runId: canonicalRunId,
      childSessionKey: child,
    });
    try {
      await held.ready;
      emitAgentEvent({
        runId: physicalRunId,
        sessionKey: child,
        stream: "tool",
        data: { phase: "start", name: "read" },
      });
      held.release();
      const receipt = await pending;
      expect(receipt).toMatchObject({ created: true });
      expect(listTasksForFlowId(flow.flowId)).toMatchObject([
        { runId: canonicalRunId, toolUseCount: 1, lastToolName: "read" },
      ]);
      expect(getTaskById(canonical.taskId)).toMatchObject({
        runId: canonicalRunId,
        toolUseCount: 1,
        lastToolName: "read",
      });
    } finally {
      held.release();
      await pending;
      if (subagentRuns.get(physicalRunId) === entry) {
        subagentRuns.delete(physicalRunId);
      }
    }
  });

  it("captures completion before the initial task receipt is delivered", async () => {
    const held = holdTaskCreationCommand("tasks.createRecord", "after commit");
    const pending = createRunningTaskRunCoreWithReceiptAsync({
      runtime: "cli",
      runId,
      ownerKey,
      scopeKind: "session",
      task: "Initial unpublished task",
      notifyPolicy: "silent",
      startedAt: 100,
    });
    try {
      await held.ready;
      emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end", endedAt: 200 } });
      held.release();
      const created = await pending;
      expect(created).not.toBeNull();
      expect(getTaskById(created!.task.taskId)).toMatchObject({
        status: "succeeded",
        endedAt: 200,
      });
    } finally {
      held.release();
      await pending;
    }
  });

  it("keeps current-generation events ahead of an older held creation receipt", async () => {
    const backing = createBacking();
    const managed = createPluginRuntime().tasks.async.managedFlows.bindSession({
      sessionKey: ownerKey,
    });
    const flow = await managed.createManaged({
      controllerId: "tests/current-generation",
      goal: "Current child",
    });
    const held = holdTaskCreationCommand("flows.runTask", "after commit");
    const pending = managed.runTask({ ...childInput, flowId: flow.flowId });
    try {
      await held.ready;
      const stored = [...getTaskRegistryStore().loadSnapshot().tasks.values()].find(
        (task) => task.parentFlowId === flow.flowId,
      );
      assert(stored, "Expected committed managed link");
      const currentBacking = {
        kind: "task_backing_instance",
        runtime: "acp",
        instanceId: "instance-2",
        generation: 2,
      };
      expect(updateTask(backing.taskId, { detail: currentBacking })).not.toBeNull();
      expect(
        updateTask(stored.taskId, { detail: { ...currentBacking, taskId: backing.taskId } }),
      ).not.toBeNull();
      emitAgentEvent({
        runId,
        sessionKey: childSessionKey,
        stream: "lifecycle",
        data: { phase: "end", endedAt: 400 },
      });
      expect(getTaskById(stored.taskId)).toMatchObject({
        status: "succeeded",
        endedAt: 400,
        detail: { generation: 2 },
      });
      held.release();
      await pending;
      expect(listTasksForFlowId(flow.flowId)).toMatchObject([
        { taskId: stored.taskId, status: "succeeded", endedAt: 400, detail: { generation: 2 } },
      ]);
    } finally {
      held.release();
      await pending;
    }
  });

  it("does not invent a linked event target before the creation command executes", async () => {
    const backing = createBacking();
    const managed = createPluginRuntime().tasks.async.managedFlows.bindSession({
      sessionKey: ownerKey,
    });
    const flow = await managed.createManaged({
      controllerId: "tests/precommit",
      goal: "Uncommitted link",
    });
    const held = holdTaskCreationCommand("flows.runTask", "before execution");
    const pending = managed.runTask({ ...childInput, flowId: flow.flowId });
    try {
      await held.ready;
      emitAgentEvent({
        runId,
        sessionKey: childSessionKey,
        stream: "lifecycle",
        data: { phase: "end", endedAt: 200 },
      });
      expect(getTaskById(backing.taskId)).toMatchObject({ status: "succeeded", endedAt: 200 });
      held.release();
      expect(await pending).toMatchObject({
        created: false,
        reason: "Task backing ownership could not be verified.",
      });
      expect(listTasksForFlowId(flow.flowId)).toEqual([]);
    } finally {
      held.release();
      await pending;
    }
  });

  it.each(["generation", "run binding"] as const)(
    "rejects a held creation target after its stored %s is replaced",
    async (replacement) => {
      createBacking();
      const managed = createPluginRuntime().tasks.async.managedFlows.bindSession({
        sessionKey: ownerKey,
      });
      const flow = await managed.createManaged({
        controllerId: "tests/replacement",
        goal: "Replaced link",
      });
      const held = holdTaskCreationCommand("flows.runTask", "after commit");
      const pending = managed.runTask({ ...childInput, flowId: flow.flowId });
      try {
        await held.ready;
        const stored = [...getTaskRegistryStore().loadSnapshot().tasks.values()].find(
          (task) => task.parentFlowId === flow.flowId,
        );
        assert(stored, "Expected committed managed link");
        const replaced = {
          ...stored,
          ...(replacement === "run binding"
            ? { runId: "replacement-run" }
            : {
                detail: {
                  kind: "task_backing_instance",
                  runtime: "acp",
                  instanceId: "instance-2",
                  generation: 2,
                },
              }),
        };
        upsertTaskWithDeliveryStateToSqlite({ task: replaced });
        emitAgentEvent({
          runId,
          sessionKey: childSessionKey,
          stream: "lifecycle",
          data: { phase: "end", endedAt: 200 },
        });
        held.release();
        await pending;
        expect(listTasksForFlowId(flow.flowId)).toMatchObject([
          {
            taskId: stored.taskId,
            status: "running",
            runId: replaced.runId,
            detail: replaced.detail,
          },
        ]);
      } finally {
        held.release();
        await pending;
      }
    },
  );

  it.each(["before metadata admission", "after command rejection"] as const)(
    "preserves the separately committed requester origin when a later metadata write fails (event: %s)",
    async (eventTiming) => {
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
      const db = openOpenClawStateDatabase().db;
      await runtime.tasks.async.runs.bindSession({ sessionKey: ownerKey }).list();
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
      db.exec(
        "CREATE TRIGGER reject_task_metadata BEFORE UPDATE ON task_runs WHEN NEW.task <> OLD.task BEGIN SELECT RAISE(ABORT, 'synthetic task update failure'); END",
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
      let residentAtEvent: boolean | undefined;
      const emitCompletion = () => {
        residentAtEvent = tasks.has(taskId);
        emitAgentEvent({
          runId,
          sessionKey: ownerKey,
          stream: "lifecycle",
          data: { phase: "end", endedAt: 200 },
        });
      };
      let reachedMetadataAdmission = false;
      if (eventTiming === "before metadata admission") {
        const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
        vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
          (admit) => {
            let transactionCount = 0;
            return createAdmission((request, grant) => {
              if (
                request.stage === "transaction" &&
                isRecord(request.facts) &&
                request.facts.operation === "flows.runTask"
              ) {
                transactionCount += 1;
                if (transactionCount === 2) {
                  reachedMetadataAdmission = true;
                  emitCompletion();
                }
              }
              admit(request, grant);
            });
          },
        );
      }
      const held = holdTaskCreationCommand("flows.runTask", "after rejection");
      const pending = managed.runTask(input);
      const rejected = expect(pending).rejects.toThrow("synthetic task update failure");
      let triggerInstalled = true;
      try {
        await held.ready;
        if (eventTiming === "before metadata admission") {
          expect(reachedMetadataAdmission).toBe(true);
        }
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
        db.exec("DROP TRIGGER reject_task_metadata");
        triggerInstalled = false;
        if (eventTiming === "after command rejection") {
          emitCompletion();
        }
        expect(residentAtEvent).toBe(false);
        expect(getTaskById(taskId)).toMatchObject({
          taskId,
          status: "succeeded",
          endedAt: 200,
          task: "Original metadata",
          agentId: "main",
          sourceId: "original-source",
        });
      } finally {
        if (triggerInstalled) {
          db.exec("DROP TRIGGER reject_task_metadata");
        }
        held.release();
        await rejected;
      }
      expect(await managed.runTask(input)).toMatchObject({
        created: true,
        task: {
          taskId,
          task: "Updated metadata",
          label: "Updated label",
          status: "succeeded",
          endedAt: 200,
          deliveryStatus: "delivered",
          agentId: "main",
          sourceId: "original-source",
        },
      });
      expect(listTasksForFlowId(flow.flowId)).toHaveLength(1);
      expect(await managed.get(flow.flowId)).toMatchObject({ revision: 0 });
    },
  );
});
