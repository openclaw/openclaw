import { beforeEach, describe, expect, it, vi } from "vitest";
import { tasksHandlers } from "./tasks.js";

const hoisted = vi.hoisted(() => ({
  cancelDetachedTaskRunById: vi.fn(),
  cancelFlowById: vi.fn(),
  getFlowTaskSummary: vi.fn(),
  listTaskRecords: vi.fn(),
  listTaskFlowRecords: vi.fn(),
  listTasksForFlowId: vi.fn(),
  resolveTaskFlowForLookupToken: vi.fn(),
  resolveTaskForLookupToken: vi.fn(),
}));

vi.mock("../../tasks/task-executor.js", () => ({
  cancelDetachedTaskRunById: hoisted.cancelDetachedTaskRunById,
  cancelFlowById: hoisted.cancelFlowById,
  getFlowTaskSummary: hoisted.getFlowTaskSummary,
}));

vi.mock("../../tasks/task-flow-runtime-internal.js", () => ({
  listTaskFlowRecords: hoisted.listTaskFlowRecords,
  resolveTaskFlowForLookupToken: hoisted.resolveTaskFlowForLookupToken,
}));

vi.mock("../../tasks/runtime-internal.js", () => ({
  listTasksForFlowId: hoisted.listTasksForFlowId,
}));

vi.mock("../../tasks/task-registry.js", () => ({
  listTaskRecords: hoisted.listTaskRecords,
  resolveTaskForLookupToken: hoisted.resolveTaskForLookupToken,
}));

function task(overrides: Record<string, unknown> = {}) {
  return {
    taskId: "task_1",
    runtime: "subagent",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    task: "Ship control plane",
    status: "running",
    deliveryStatus: "pending",
    notifyPolicy: "done_only",
    createdAt: 1000,
    ...overrides,
  };
}

function flow(overrides: Record<string, unknown> = {}) {
  return {
    flowId: "flow_1",
    syncMode: "managed",
    ownerKey: "agent:main:main",
    revision: 1,
    status: "running",
    notifyPolicy: "done_only",
    goal: "Ship control plane",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

async function call(
  method:
    | "tasks.list"
    | "tasks.get"
    | "tasks.cancel"
    | "tasks.flows.list"
    | "tasks.flows.get"
    | "tasks.flows.cancel",
  params: unknown,
) {
  const respond = vi.fn();
  await tasksHandlers[method]?.({
    params: params as Record<string, unknown>,
    respond,
    context: { getRuntimeConfig: () => ({}) },
  } as never);
  return respond.mock.calls[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.listTaskRecords.mockReturnValue([
    task(),
    task({ taskId: "task_2", status: "succeeded" }),
  ]);
  hoisted.resolveTaskForLookupToken.mockReturnValue(task());
  hoisted.listTaskFlowRecords.mockReturnValue([
    flow(),
    flow({ flowId: "flow_2", status: "blocked" }),
    flow({ flowId: "flow_3", status: "succeeded" }),
  ]);
  hoisted.resolveTaskFlowForLookupToken.mockReturnValue(flow());
  hoisted.listTasksForFlowId.mockReturnValue([task()]);
  hoisted.getFlowTaskSummary.mockReturnValue({
    total: 1,
    active: 1,
    terminal: 0,
    failures: 0,
    byStatus: {
      queued: 0,
      running: 1,
      succeeded: 0,
      failed: 0,
      timed_out: 0,
      cancelled: 0,
      lost: 0,
    },
    byRuntime: {
      subagent: 1,
      acp: 0,
      cli: 0,
      cron: 0,
    },
  });
  hoisted.cancelDetachedTaskRunById.mockResolvedValue({
    found: true,
    cancelled: true,
    task: task({ status: "cancelled" }),
  });
  hoisted.cancelFlowById.mockResolvedValue({
    found: true,
    cancelled: true,
    flow: flow({ status: "cancelled" }),
  });
});

describe("tasks gateway methods", () => {
  it("lists task runs with optional active filtering", async () => {
    const [ok, payload] = await call("tasks.list", { active: true });

    expect(ok).toBe(true);
    expect(payload).toEqual({
      tasks: [
        expect.objectContaining({
          id: "task_1",
          title: "Ship control plane",
          status: "running",
          sessionKey: "agent:main:main",
        }),
      ],
    });
  });

  it("gets one task by lookup token", async () => {
    const [ok, payload] = await call("tasks.get", { taskId: "task_1" });

    expect(ok).toBe(true);
    expect(hoisted.resolveTaskForLookupToken).toHaveBeenCalledWith("task_1");
    expect(payload).toMatchObject({ task: { id: "task_1", status: "running" } });
  });

  it("rejects unknown task ids", async () => {
    hoisted.resolveTaskForLookupToken.mockReturnValue(undefined);

    const [ok, , error] = await call("tasks.get", { taskId: "missing" });

    expect(ok).toBe(false);
    expect(error).toMatchObject({ code: "INVALID_REQUEST", message: "unknown taskId" });
  });

  it("cancels through the detached task runtime", async () => {
    const [ok, payload] = await call("tasks.cancel", { taskId: "task_1" });

    expect(ok).toBe(true);
    expect(hoisted.cancelDetachedTaskRunById).toHaveBeenCalledWith({ cfg: {}, taskId: "task_1" });
    expect(payload).toMatchObject({
      found: true,
      cancelled: true,
      task: { id: "task_1", status: "cancelled" },
    });
  });

  it("lists active TaskFlows with linked task summaries", async () => {
    const [ok, payload] = await call("tasks.flows.list", { active: true });

    expect(ok).toBe(true);
    expect(payload).toEqual({
      flows: [
        expect.objectContaining({
          id: "flow_1",
          syncMode: "managed",
          status: "running",
          taskSummary: expect.objectContaining({ total: 1, active: 1 }),
          tasks: [expect.objectContaining({ id: "task_1" })],
        }),
      ],
    });
  });

  it("gets a TaskFlow by lookup token", async () => {
    const [ok, payload] = await call("tasks.flows.get", { flowId: "flow_1" });

    expect(ok).toBe(true);
    expect(hoisted.resolveTaskFlowForLookupToken).toHaveBeenCalledWith("flow_1");
    expect(payload).toMatchObject({ flow: { id: "flow_1", status: "running" } });
  });

  it("rejects unknown TaskFlow ids", async () => {
    hoisted.resolveTaskFlowForLookupToken.mockReturnValue(undefined);

    const [ok, , error] = await call("tasks.flows.get", { flowId: "missing" });

    expect(ok).toBe(false);
    expect(error).toMatchObject({ code: "INVALID_REQUEST", message: "unknown flowId" });
  });

  it("cancels through the TaskFlow runtime", async () => {
    const [ok, payload] = await call("tasks.flows.cancel", { flowId: "flow_1" });

    expect(ok).toBe(true);
    expect(hoisted.cancelFlowById).toHaveBeenCalledWith({ cfg: {}, flowId: "flow_1" });
    expect(payload).toMatchObject({
      found: true,
      cancelled: true,
      flow: { id: "flow_1", status: "cancelled" },
    });
  });
});
