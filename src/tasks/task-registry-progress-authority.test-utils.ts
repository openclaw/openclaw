import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import type {
  ProgressContinuationCapability,
  ProgressContinuationReceipt,
} from "../channels/progress-continuation.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  createSubagentTaskBackingDetail,
  resolveManagedTaskBackingDetail,
} from "./task-backing-authority.js";
import {
  createManagedTaskFlow,
  createTaskFlowForTask,
  runTaskFlowRegistryWorkerMutation,
} from "./task-flow-registry.js";
import { getTaskFlowRegistryStore } from "./task-flow-registry.store.js";
import { withTaskProgressRequesterContinuation } from "./task-progress-requester.js";
import { captureTaskAgentEventTarget } from "./task-registry-agent-event-target.js";
import type {
  deleteTaskProgressMessage,
  publishTaskProgressMessage,
  TaskProgressPublication,
} from "./task-registry-progress-runtime.js";
import { flushTaskProgressBatch, getTaskProgressBatchesForRuns } from "./task-registry-progress.js";
import { linkTaskToFlowById } from "./task-registry-record-api.js";
import { runTaskRegistryWorkerMutation, tasks } from "./task-registry-state.js";
import { createTaskRecord, markTaskTerminalById } from "./task-registry.js";
import { getTaskRegistryStore } from "./task-registry.store.js";
import type { TaskNotifyPolicy, TaskRecord } from "./task-registry.types.js";

export type TaskProgressTestChild = {
  entry: SubagentRunRecord;
  task: TaskRecord;
  claim: string;
};

type TaskProgressAuthorityFixture = {
  requesterSessionKey: string;
  origin: TaskProgressPublication["origin"];
  child: (
    name: string,
    options?: { notifyPolicy?: TaskNotifyPolicy; turn?: string },
  ) => TaskProgressTestChild;
  adopt: (items: readonly TaskProgressTestChild[]) => Promise<ProgressContinuationCapability>;
  runtime: {
    publishTaskProgressMessage: Mock<typeof publishTaskProgressMessage>;
    deleteTaskProgressMessage: Mock<typeof deleteTaskProgressMessage>;
  };
  publications: Array<TaskProgressPublication & { messageId: string }>;
  receipts: Map<string, ProgressContinuationReceipt>;
  tool: (entry: SubagentRunRecord, index?: number) => void;
};

export function registerTaskProgressAuthorityTests({
  requesterSessionKey: PARENT,
  origin,
  child,
  adopt,
  runtime,
  publications,
  receipts,
  tool,
}: TaskProgressAuthorityFixture): void {
  function managedChild() {
    const item = child("Managed", { notifyPolicy: "silent" });
    const mirror = expectDefined(createTaskFlowForTask({ task: item.task }), "canonical flow");
    linkTaskToFlowById({ taskId: item.task.taskId, flowId: mirror.flowId });
    const flow = expectDefined(
      createManagedTaskFlow({
        ownerKey: PARENT,
        controllerId: "tests/progress-authority",
        goal: "Show admitted progress",
        requesterOrigin: origin,
      }),
      "managed flow",
    );
    const scope = {
      runtime: "subagent" as const,
      scopeKind: "session" as const,
      ownerKey: PARENT,
      childSessionKey: item.entry.childSessionKey,
      runId: item.entry.runId,
    };
    expect(
      createTaskRecord({
        ...scope,
        requesterAgentId: "main",
        task: "Show admitted progress",
        status: "running",
        deliveryStatus: "pending",
        notifyPolicy: "state_changes",
        parentFlowId: flow.flowId,
        requesterOrigin: origin,
        detail: resolveManagedTaskBackingDetail(scope),
      }),
    ).not.toBeNull();
    return { item, flow };
  }

  it.each(["same child", "unrelated child"] as const)(
    "checks accepted nonresident canonical candidates at publication (%s)",
    async (relation) => {
      const { item } = managedChild();
      await adopt([item]);
      const candidate: TaskRecord = {
        ...item.task,
        taskId: "accepted-new-canonical-task",
        runId: "new-canonical-run",
        ownerKey: "agent:main:another-owner",
        childSessionKey:
          relation === "same child" ? item.entry.childSessionKey : "agent:main:subagent:unrelated",
        detail: createSubagentTaskBackingDetail(2),
      };
      const mirror = expectDefined(
        createTaskFlowForTask({ task: candidate }),
        "new canonical flow",
      );
      candidate.parentFlowId = mirror.flowId;
      const store = getTaskRegistryStore();
      const context = captureOpenClawStateWorkerContext();
      const release = createDeferred();
      let pending: Promise<void> | undefined;
      const publish = runtime.publishTaskProgressMessage.getMockImplementation()!;
      runtime.publishTaskProgressMessage.mockImplementationOnce(async (params) => {
        pending = runTaskRegistryWorkerMutation(
          {
            admission: context.admission,
            scope: { taskId: candidate.taskId, runId: candidate.runId },
            readEventTarget: () => captureTaskAgentEventTarget(candidate),
            publicationRecords: () => new Map([[candidate.taskId, candidate]]),
          },
          async () => {
            await release.promise;
            store.upsertTaskWithDeliveryState({ task: candidate });
          },
          async () => store.loadSnapshot(),
        );
        expect(tasks.has(candidate.taskId)).toBe(false);
        return publish(params);
      });
      try {
        await vi.advanceTimersByTimeAsync(15_000);
        expect(runtime.publishTaskProgressMessage).toHaveBeenCalledOnce();
        expect(publications).toHaveLength(relation === "same child" ? 0 : 1);
      } finally {
        release.resolve();
        await pending;
      }
    },
  );

  it.each(["audience", "classification"] as const)(
    "rejects an adopted-card send while its flow %s change is unpublished",
    async (change) => {
      const { item, flow } = managedChild();
      await adopt([item]);
      const context = captureOpenClawStateWorkerContext();
      const store = getTaskFlowRegistryStore();
      const release = createDeferred();
      const publish = runtime.publishTaskProgressMessage.getMockImplementation()!;
      runtime.publishTaskProgressMessage.mockImplementationOnce(async (params) => {
        const pending = runTaskFlowRegistryWorkerMutation(
          { flowId: flow.flowId, admission: context.admission },
          async () => {
            await release.promise;
            store.upsertFlow({
              ...flow,
              ...(change === "audience"
                ? { requesterOrigin: { ...origin, to: "new-audience" } }
                : { syncMode: "task_mirrored" as const }),
            });
          },
          () => store.readFlowAsync(context, flow.flowId),
        );
        try {
          return await publish(params);
        } finally {
          release.resolve();
          await pending;
        }
      });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(runtime.publishTaskProgressMessage).toHaveBeenCalledOnce();
      expect(publications).toEqual([]);
    },
  );
  it.each(["final", "private consumption", "failed delivery", "superseded"] as const)(
    "removes adopted progress only after a current source final: %s",
    async (outcome) => {
      const item = child("Worker");
      await adopt([item]);
      item.entry.execution = { status: "terminal", endedAt: Date.now() };
      markTaskTerminalById({ taskId: item.task.taskId, status: "succeeded", endedAt: Date.now() });
      let current = true;
      await withTaskProgressRequesterContinuation(
        {
          entries: [item.entry],
          runId: "resumed-requester",
          requesterSessionId: "requester-window",
          isCurrent: () => current,
        },
        async () => {
          current = outcome !== "superseded";
          return {
            delivered: outcome !== "failed delivery",
            path: "direct",
            ...(outcome !== "private consumption" ? { requesterVisibleFinalDelivered: true } : {}),
          };
        },
      );
      expect([...receipts.values()].map((card) => card.messageId)).toEqual(
        outcome === "final" ? [] : ["existing-parent-card"],
      );
      item.entry.requesterSettleWake = undefined;
      tool(item.entry, 2);
      await vi.advanceTimersByTimeAsync(15_000);
      if (outcome === "final") {
        expect(publications).toEqual([]);
        expect(receipts.size).toBe(0);
      }
    },
  );

  it("joins an in-flight edit before removing the adopted message", async () => {
    const item = child("Worker");
    await adopt([item]);
    item.entry.execution = { status: "terminal", endedAt: Date.now() };
    markTaskTerminalById({ taskId: item.task.taskId, status: "succeeded", endedAt: Date.now() });
    const [selected] = await getTaskProgressBatchesForRuns([item.entry]);
    if (!selected) {
      throw new Error("Expected the adopted batch");
    }
    const entered = createDeferred();
    const release = createDeferred();
    let editing = false;
    runtime.publishTaskProgressMessage.mockImplementationOnce(async () => {
      editing = true;
      entered.resolve();
      await release.promise;
      editing = false;
      return "sent";
    });
    runtime.deleteTaskProgressMessage.mockImplementation(async (params) => {
      params.assertCurrent();
      if (editing) {
        throw new Error("Deletion raced an unsettled edit");
      }
      return receipts.delete(params.operationId) ? "sent" : "unknown";
    });
    const publication = flushTaskProgressBatch(selected.key, selected.batch);
    await entered.promise;
    try {
      const completion = withTaskProgressRequesterContinuation(
        {
          entries: [item.entry],
          runId: "resumed-requester",
          requesterSessionId: "requester-window",
          isCurrent: () => true,
        },
        async () => ({ delivered: true, path: "direct", requesterVisibleFinalDelivered: true }),
      );
      await vi.advanceTimersByTimeAsync(0);
      tool(item.entry, 2);
      release.resolve();
      await completion;
      expect(receipts.size).toBe(0);
    } finally {
      release.resolve();
      await publication;
    }
  });
  it("rechecks authority at publication and preserves newer activity arriving during transport", async () => {
    const first = child("First");
    await adopt([first]);
    const publish = runtime.publishTaskProgressMessage.getMockImplementation()!;
    runtime.publishTaskProgressMessage.mockImplementationOnce(async (params) => {
      first.entry.killIntent = { requestedAt: Date.now(), reason: "cancelled at handoff" };
      return publish(params);
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(publications).toEqual([]);
    const second = child("Second", { turn: "second-turn" });
    await adopt([second]);
    runtime.publishTaskProgressMessage.mockImplementationOnce(async (params) => {
      tool(second.entry, 2);
      return publish(params);
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(publications).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(publications).toHaveLength(2);
    expect(publications[1]!.content).toContain("public-notes-2.txt");
    expect(publications[1]!.content).toContain("Check release gates");
    expect(publications.every((display) => display.messageId === "existing-parent-card")).toBe(
      true,
    );
    expect(publications.map((display) => display.origin)).toEqual([origin, origin]);
  });
}
