import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDeliveryState, TaskRecord } from "./task-registry.types.js";

const memory = vi.hoisted(() => ({
  tasks: new Map<string, TaskRecord>(),
  delivery: new Map<string, TaskDeliveryState>(),
  writes: [] as TaskRecord[],
  restore: undefined as (() => void) | undefined,
}));

vi.mock("./task-registry-state.js", () => ({
  tasks: memory.tasks,
  taskDeliveryStates: memory.delivery,
  ensureTaskRegistryReady() {},
  withTaskRegistryMutation: <T>(operation: () => T) => operation(),
  getTasksByRunId: (runId: string) =>
    [...memory.tasks.values()].filter((task) => task.runId === runId),
  bumpTaskRegistryRevision() {},
  syncFlowFromTaskAfterTaskMutation() {},
  emitTaskRegistryObserverEvent() {},
}));
vi.mock("./task-flow-runtime-internal.js", () => {
  const restore = () => {
    const callback = memory.restore;
    memory.restore = undefined;
    callback?.();
  };
  return {
    getTaskMirroredFlowIds: () => {
      restore();
      return new Set(["mirrored-flow"]);
    },
    ensureTaskFlowRegistryReady: restore,
  };
});
vi.mock("./task-registry.store.js", () => ({
  tryPersistTaskUpsert: (task: TaskRecord) => {
    memory.writes.push(task);
    return true;
  },
}));
vi.mock("./task-registry-mutation.js", () => ({
  publishTaskRecordUpdate: (_previous: TaskRecord, task: TaskRecord) => {
    memory.tasks.set(task.taskId, task);
    return task;
  },
}));
vi.mock("./task-registry.process-state.js", () => ({
  addOwnerKeyIndex() {},
  addParentFlowIdIndex() {},
  addRelatedSessionKeyIndex() {},
  addRunIdIndex() {},
}));
vi.mock("./task-registry-delivery.js", () => ({
  maybeDeliverTaskTerminalUpdate: async () => {},
}));

import { createAcpTaskBackingDetail } from "./task-backing-records.js";
import { createTaskRecord } from "./task-registry-create.native.js";

const original: TaskRecord = {
  taskId: "selected-task",
  runtime: "acp",
  requesterSessionKey: "agent:requester:main",
  ownerKey: "agent:requester:main",
  scopeKind: "session",
  childSessionKey: "agent:child:acp:example",
  parentFlowId: "mirrored-flow",
  runId: "selected-run",
  task: "Original request",
  status: "running",
  deliveryStatus: "not_applicable",
  notifyPolicy: "silent",
  createdAt: 100,
  detail: createAcpTaskBackingDetail("selected-instance", 1),
};

beforeEach(() => {
  memory.tasks.clear();
  memory.delivery.clear();
  memory.writes.length = 0;
  memory.restore = undefined;
  memory.tasks.set(original.taskId, structuredClone(original));
});

describe("native create selection after mirrored-flow restoration", () => {
  it.each(["removal", "replacement", "metadata", "backing"] as const)(
    "revalidates %s before reusing the selected task",
    (change) => {
      memory.restore = () => {
        if (change === "removal") {
          memory.tasks.delete(original.taskId);
        } else {
          memory.tasks.set(original.taskId, {
            ...original,
            progressSummary: "Observer progress",
            ...(change === "replacement" ? { createdAt: 101 } : {}),
            ...(change === "backing"
              ? { detail: createAcpTaskBackingDetail("replacement-instance", 2) }
              : {}),
          });
        }
      };
      const created = createTaskRecord({
        ...original,
        parentFlowId: undefined,
        task: "Updated request",
        preferMetadata: true,
      });

      if (change === "metadata") {
        expect(created).toMatchObject({
          taskId: original.taskId,
          task: "Updated request",
          progressSummary: "Observer progress",
        });
        expect(memory.writes).toEqual([created]);
      } else {
        expect(created).toBeNull();
        expect(memory.writes).toEqual([]);
        if (change === "removal") {
          expect(memory.tasks.has(original.taskId)).toBe(false);
        } else {
          expect(memory.tasks.get(original.taskId)).toMatchObject({
            task: "Original request",
            progressSummary: "Observer progress",
            createdAt: change === "replacement" ? 101 : 100,
            detail:
              change === "backing"
                ? createAcpTaskBackingDetail("replacement-instance", 2)
                : original.detail,
          });
        }
      }
    },
  );
});
