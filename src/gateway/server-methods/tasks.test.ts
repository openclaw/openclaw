import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../protocol/index.js";
import { tasksHandlers } from "./tasks.js";

const taskDomainMocks = vi.hoisted(() => ({
  mapTaskFlowDetail: vi.fn(
    (params: {
      flow: { flowId: string; status: string; blockedSummary?: string | null };
      tasks: Array<{ taskId: string }>;
      summary: { total: number };
    }) => ({
      id: params.flow.flowId,
      ownerKey: "agent:main:main",
      status: params.flow.status,
      notifyPolicy: "state_changes",
      goal: "Goal",
      createdAt: 1,
      updatedAt: 2,
      blocked: params.flow.blockedSummary ? { summary: params.flow.blockedSummary } : undefined,
      tasks: params.tasks.map((task) => ({ id: task.taskId })),
      taskSummary: params.summary,
    }),
  ),
  mapTaskRunAggregateSummary: vi.fn((summary: { total: number }) => ({
    total: summary.total,
    active: summary.total,
    terminal: 0,
    failures: 0,
    byStatus: {
      queued: 0,
      running: summary.total,
      succeeded: 0,
      failed: 0,
      timed_out: 0,
      cancelled: 0,
      lost: 0,
    },
    byRuntime: {
      subagent: summary.total,
      acp: 0,
      cli: 0,
      cron: 0,
    },
  })),
  mapTaskRunDetail: vi.fn((task: { taskId: string; task: string; status: string }) => ({
    id: task.taskId,
    title: task.task,
    status: task.status,
  })),
  mapTaskRunView: vi.fn((task: { taskId: string; status: string }) => ({
    id: task.taskId,
    status: task.status,
  })),
  listTaskFlowRecords: vi.fn(),
  reconcileInspectableTasks: vi.fn(),
  reconcileTaskLookupToken: vi.fn(),
  reconcileTaskRecordForOperatorInspection: vi.fn((task) => task),
  summarizeTaskRecords: vi.fn((tasks: unknown[]) => ({ total: tasks.length })),
  getTaskById: vi.fn(),
  listTasksForFlowId: vi.fn(),
}));

vi.mock("../../tasks/task-domain-views.js", () => ({
  mapTaskFlowDetail: taskDomainMocks.mapTaskFlowDetail,
  mapTaskRunAggregateSummary: taskDomainMocks.mapTaskRunAggregateSummary,
  mapTaskRunDetail: taskDomainMocks.mapTaskRunDetail,
  mapTaskRunView: taskDomainMocks.mapTaskRunView,
}));

vi.mock("../../tasks/task-flow-registry.js", () => ({
  listTaskFlowRecords: taskDomainMocks.listTaskFlowRecords,
}));

vi.mock("../../tasks/task-registry.maintenance.js", () => ({
  reconcileInspectableTasks: taskDomainMocks.reconcileInspectableTasks,
  reconcileTaskLookupToken: taskDomainMocks.reconcileTaskLookupToken,
  reconcileTaskRecordForOperatorInspection:
    taskDomainMocks.reconcileTaskRecordForOperatorInspection,
}));

vi.mock("../../tasks/task-registry.summary.js", () => ({
  summarizeTaskRecords: taskDomainMocks.summarizeTaskRecords,
}));

vi.mock("../../tasks/task-registry.js", () => ({
  getTaskById: taskDomainMocks.getTaskById,
  listTasksForFlowId: taskDomainMocks.listTasksForFlowId,
}));

type RespondCall = [boolean, unknown?, { code: number; message: string }?];

function createInvoke(method: keyof typeof tasksHandlers, params: Record<string, unknown>) {
  const respond = vi.fn();
  return {
    respond,
    invoke: async () =>
      await tasksHandlers[method]({
        params,
        respond: respond as never,
        context: {} as never,
        client: null,
        req: { type: "req", id: "req-1", method },
        isWebchatConnect: () => false,
      }),
  };
}

describe("tasks handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects invalid params for tasks.list", async () => {
    const { respond, invoke } = createInvoke("tasks.list", { extra: true });

    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("invalid tasks.list params");
  });

  it("filters, sorts, and limits tasks.list results", async () => {
    taskDomainMocks.reconcileInspectableTasks.mockReturnValue([
      {
        taskId: "task-queued",
        task: "Source audit queued",
        label: "Queue",
        runId: "run-queued",
        agentId: "main",
        requesterSessionKey: "agent:main:main",
        ownerKey: "agent:main:main",
        parentFlowId: "flow-1",
        progressSummary: "waiting",
        status: "queued",
        runtime: "subagent",
        createdAt: 1,
        lastEventAt: 2,
      },
      {
        taskId: "task-running",
        task: "Source audit running",
        label: "Running",
        runId: "run-running",
        agentId: "main",
        requesterSessionKey: "agent:main:main",
        ownerKey: "agent:main:main",
        parentFlowId: "flow-1",
        progressSummary: "working",
        status: "running",
        runtime: "subagent",
        createdAt: 2,
        lastEventAt: 10,
      },
      {
        taskId: "task-other",
        task: "Other work",
        label: "Other",
        runId: "run-other",
        agentId: "main",
        requesterSessionKey: "agent:main:main",
        ownerKey: "agent:main:main",
        parentFlowId: "flow-2",
        progressSummary: "working",
        status: "running",
        runtime: "acp",
        createdAt: 3,
        lastEventAt: 8,
      },
    ]);

    const { respond, invoke } = createInvoke("tasks.list", {
      query: "source audit",
      statuses: ["running", "queued"],
      runtime: "subagent",
      limit: 1,
    });

    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toEqual({
      tasks: [{ id: "task-running", status: "running" }],
      summary: expect.objectContaining({ total: 1, active: 1 }),
    });
  });

  it("resolves tasks.show by token", async () => {
    taskDomainMocks.reconcileTaskLookupToken.mockReturnValue({
      taskId: "task-token",
      task: "Token task",
      status: "running",
    });

    const { respond, invoke } = createInvoke("tasks.show", { token: "lookup-token" });

    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(taskDomainMocks.reconcileTaskLookupToken).toHaveBeenCalledWith("lookup-token");
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toEqual({
      task: { id: "task-token", title: "Token task", status: "running" },
    });
  });

  it("returns blocked flow details from tasks.flows.list", async () => {
    taskDomainMocks.listTaskFlowRecords.mockReturnValue([
      {
        flowId: "flow-blocked",
        ownerKey: "agent:main:main",
        goal: "Finish auth flow",
        currentStep: "Waiting",
        blockedSummary: "Need auth.",
        status: "blocked",
        createdAt: 1,
        updatedAt: 20,
      },
      {
        flowId: "flow-running",
        ownerKey: "agent:main:main",
        goal: "Other flow",
        currentStep: "Running",
        status: "running",
        createdAt: 1,
        updatedAt: 30,
      },
    ]);
    taskDomainMocks.listTasksForFlowId.mockReturnValue([
      {
        taskId: "task-secured",
        status: "succeeded",
      },
    ]);

    const { respond, invoke } = createInvoke("tasks.flows.list", {
      statuses: ["blocked"],
      query: "auth",
      limit: 1,
    });

    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toEqual({
      flows: [
        expect.objectContaining({
          id: "flow-blocked",
          status: "blocked",
          blocked: { summary: "Need auth." },
        }),
      ],
    });
  });
});
