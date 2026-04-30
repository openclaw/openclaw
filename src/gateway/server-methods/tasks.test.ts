import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import { ErrorCodes } from "../protocol/index.js";
import { tasksHandlers } from "./tasks.js";

const taskMocks = vi.hoisted(() => ({
  cancelDetachedTaskRunById: vi.fn(),
  getTaskById: vi.fn(),
  listTaskRecords: vi.fn(),
}));

vi.mock("../../tasks/runtime-internal.js", () => ({
  getTaskById: taskMocks.getTaskById,
  listTaskRecords: taskMocks.listTaskRecords,
}));

vi.mock("../../tasks/task-executor.js", () => ({
  cancelDetachedTaskRunById: taskMocks.cancelDetachedTaskRunById,
}));

type RespondCall = [boolean, unknown?, { code: number; message: string }?];

function makeTask(overrides: Partial<TaskRecord>): TaskRecord {
  return {
    taskId: "task-1",
    runtime: "subagent",
    requesterSessionKey: "main:requester",
    ownerKey: "main:owner",
    scopeKind: "session",
    task: "Review the diff",
    status: "running",
    deliveryStatus: "pending",
    notifyPolicy: "state_changes",
    createdAt: 100,
    ...overrides,
  };
}

function createInvokeParams(method: keyof typeof tasksHandlers, params: Record<string, unknown>) {
  const respond = vi.fn();
  return {
    respond,
    invoke: async () =>
      await tasksHandlers[method]({
        params,
        respond: respond as never,
        context: { getRuntimeConfig: () => ({}) } as never,
        client: null,
        req: { type: "req", id: "req-1", method },
        isWebchatConnect: () => false,
      }),
  };
}

describe("tasks Gateway handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects invalid tasks.list params", async () => {
    const { respond, invoke } = createInvokeParams("tasks.list", { status: "done" });

    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("invalid tasks.list params");
    expect(taskMocks.listTaskRecords).not.toHaveBeenCalled();
  });

  it("lists tasks with status, agent, session, and limit filters", async () => {
    const matching = makeTask({
      taskId: "task-match",
      agentId: "main",
      status: "running",
      childSessionKey: "session-1",
    });
    const secondMatch = makeTask({
      taskId: "task-second",
      agentId: "main",
      status: "queued",
      ownerKey: "session-1",
    });
    taskMocks.listTaskRecords.mockReturnValue([
      matching,
      secondMatch,
      makeTask({ taskId: "wrong-agent", agentId: "secondary", childSessionKey: "session-1" }),
      makeTask({ taskId: "wrong-session", agentId: "main", childSessionKey: "session-2" }),
      makeTask({ taskId: "wrong-status", agentId: "main", status: "failed" }),
    ]);
    const { respond, invoke } = createInvokeParams("tasks.list", {
      status: ["running", "queued"],
      agentId: "main",
      sessionKey: "session-1",
      limit: 1,
    });

    await invoke();

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        count: 1,
        tasks: [matching],
      },
      undefined,
    );
  });

  it("gets a task by stable task id", async () => {
    const task = makeTask({ taskId: "task-123" });
    taskMocks.getTaskById.mockReturnValue(task);
    const { respond, invoke } = createInvokeParams("tasks.get", { taskId: "task-123" });

    await invoke();

    expect(taskMocks.getTaskById).toHaveBeenCalledWith("task-123");
    expect(respond).toHaveBeenCalledWith(true, { found: true, task }, undefined);
  });

  it("returns a clear not-found result for missing tasks", async () => {
    taskMocks.getTaskById.mockReturnValue(undefined);
    const { respond, invoke } = createInvokeParams("tasks.get", { taskId: "missing-task" });

    await invoke();

    expect(respond).toHaveBeenCalledWith(true, { found: false }, undefined);
  });

  it("cancels a task through the detached task executor", async () => {
    const task = makeTask({ taskId: "task-123", status: "cancelled" });
    taskMocks.cancelDetachedTaskRunById.mockResolvedValue({
      found: true,
      cancelled: true,
      task,
    });
    const { respond, invoke } = createInvokeParams("tasks.cancel", { taskId: " task-123 " });

    await invoke();

    expect(taskMocks.cancelDetachedTaskRunById).toHaveBeenCalledWith({
      cfg: {},
      taskId: "task-123",
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        found: true,
        cancelled: true,
        task,
      },
      undefined,
    );
  });
});
