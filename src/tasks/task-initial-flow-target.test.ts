import { DatabaseSync } from "node:sqlite";
import { beforeEach, expect, it, vi } from "vitest";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import { finalizeInitialTaskManagedCancellationInDatabase } from "./task-initial-flow.kernel.js";
import type { TaskRecord } from "./task-registry.types.js";

const { readTask, readFlow, listTasks, writeFlow } = vi.hoisted(() => ({
  readTask: vi.fn<typeof import("./task-registry.store.kernel.js").readTaskRecord>(),
  readFlow: vi.fn<typeof import("./task-flow-registry.store.kernel.js").readTaskFlowRecord>(),
  listTasks:
    vi.fn<typeof import("./task-registry.store.kernel.js").listTaskRecordsForFlowReadInDatabase>(),
  writeFlow:
    vi.fn<typeof import("./task-flow-registry.store.kernel.js").upsertTaskFlowRowInDatabase>(),
}));
// This control exercises the real target kernel with no native SQLite connection.
vi.mock("node:sqlite", () => ({
  DatabaseSync: class {
    readonly isTransaction = true;
  },
}));
vi.mock("./task-registry.store.kernel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./task-registry.store.kernel.js")>()),
  readTaskRecord: readTask,
  listTaskRecordsForFlowReadInDatabase: listTasks,
}));
vi.mock("./task-flow-registry.store.kernel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./task-flow-registry.store.kernel.js")>()),
  readTaskFlowRecord: readFlow,
  upsertTaskFlowRowInDatabase: writeFlow,
}));

const task: TaskRecord = {
  taskId: "target-task",
  runtime: "cli",
  requesterSessionKey: "agent:main:target",
  ownerKey: "agent:main:target",
  scopeKind: "session",
  parentFlowId: "original-flow",
  runId: "target-run",
  task: "Synthetic terminal task",
  status: "failed",
  deliveryStatus: "not_applicable",
  notifyPolicy: "silent",
  createdAt: 1,
  endedAt: 2,
};
const flow: TaskFlowRecord = {
  flowId: "original-flow",
  syncMode: "managed",
  controllerId: "proof",
  ownerKey: task.ownerKey,
  goal: "Synthetic flow",
  status: "running",
  notifyPolicy: "silent",
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  cancelRequestedAt: 2,
};
beforeEach(() => {
  readTask.mockReset().mockReturnValue(task);
  readFlow.mockReset().mockReturnValue(flow);
  listTasks.mockReset().mockReturnValue([task]);
  writeFlow.mockReset();
});

it("refuses a rebound parent before reading or modifying any flow", () => {
  const rebound = { ...task, parentFlowId: "successor-flow" };
  readTask.mockReturnValue(rebound);
  readFlow.mockReturnValue({ ...flow, flowId: "successor-flow" });
  const admit = vi.fn();
  const result = finalizeInitialTaskManagedCancellationInDatabase(
    new DatabaseSync(":memory:"),
    { taskId: task.taskId, flowId: flow.flowId, now: 3 },
    admit,
  );
  expect(result).toEqual({ changed: false, task: rebound, flow: null });
  expect(readFlow).not.toHaveBeenCalled();
  expect(listTasks).not.toHaveBeenCalled();
  expect(admit).not.toHaveBeenCalled();
  expect(writeFlow).not.toHaveBeenCalled();
});

it("settles only the captured flow while the canonical task still links to it", () => {
  const database = new DatabaseSync(":memory:");
  const admit = vi.fn();
  const result = finalizeInitialTaskManagedCancellationInDatabase(
    database,
    { taskId: task.taskId, flowId: flow.flowId, now: 3 },
    admit,
  );
  expect(result).toMatchObject({
    changed: true,
    flow: { flowId: flow.flowId, status: "cancelled" },
  });
  expect(admit).toHaveBeenCalledWith({ task, flow });
  expect(writeFlow).toHaveBeenCalledWith(
    database,
    expect.objectContaining({ flow_id: flow.flowId, status: "cancelled" }),
  );
});

it.each([undefined, "", " \t"])(
  "cancels a supported legacy managed flow with controller %s",
  (controllerId) => {
    const stored = { ...flow, controllerId };
    readFlow.mockReturnValue(stored);
    const database = new DatabaseSync(":memory:");
    const admit = vi.fn();
    const result = finalizeInitialTaskManagedCancellationInDatabase(
      database,
      { taskId: task.taskId, flowId: flow.flowId, now: 3 },
      admit,
    );
    expect(result).toMatchObject({
      changed: true,
      flow: { flowId: flow.flowId, status: "cancelled", controllerId: "core/legacy-restored" },
    });
    expect(admit).toHaveBeenCalledWith({
      task,
      flow: expect.objectContaining({ controllerId: "core/legacy-restored" }),
    });
    expect(writeFlow).toHaveBeenCalledOnce();
    expect(writeFlow).toHaveBeenCalledWith(
      database,
      expect.objectContaining({
        flow_id: flow.flowId,
        controller_id: "core/legacy-restored",
        status: "cancelled",
        revision: flow.revision + 1,
      }),
    );
    expect(stored.controllerId).toBe(controllerId);
  },
);
