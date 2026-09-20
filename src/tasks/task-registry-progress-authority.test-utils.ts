import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import type { ProgressContinuationCapability } from "../channels/progress-continuation.js";
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
import { captureTaskAgentEventTarget } from "./task-registry-agent-event-target.js";
import type {
  publishTaskProgressMessage,
  TaskProgressPublication,
} from "./task-registry-progress-runtime.js";
import { linkTaskToFlowById } from "./task-registry-record-api.js";
import { runTaskRegistryWorkerMutation, tasks } from "./task-registry-state.js";
import { createTaskRecord } from "./task-registry.js";
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
  child: (name: string, options?: { notifyPolicy?: TaskNotifyPolicy }) => TaskProgressTestChild;
  adopt: (items: readonly TaskProgressTestChild[]) => Promise<ProgressContinuationCapability>;
  runtime: { publishTaskProgressMessage: Mock<typeof publishTaskProgressMessage> };
  publications: Array<TaskProgressPublication & { messageId: string }>;
};

export function registerTaskProgressAuthorityTests({
  requesterSessionKey: PARENT,
  origin,
  child,
  adopt,
  runtime,
  publications,
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
}
