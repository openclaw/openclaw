import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTaskFlowRegistryForTests } from "../../tasks/task-flow-registry.js";
import {
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
  setTaskRegistryDeliveryRuntimeForTests,
} from "../../tasks/task-registry.js";
import { createRuntimeTaskFlow } from "./runtime-taskflow.js";
import { createRuntimeTaskFlows, createRuntimeTaskRuns } from "./runtime-tasks.js";

const hoisted = vi.hoisted(() => {
  const sendMessageMock = vi.fn();
  const cancelSessionMock = vi.fn();
  const killSubagentRunAdminMock = vi.fn();
  return {
    sendMessageMock,
    cancelSessionMock,
    killSubagentRunAdminMock,
  };
});

vi.mock("../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    cancelSession: hoisted.cancelSessionMock,
  }),
}));

vi.mock("../../agents/subagent-control.js", () => ({
  killSubagentRunAdmin: (params: unknown) => hoisted.killSubagentRunAdminMock(params),
}));

afterEach(() => {
  resetTaskRegistryDeliveryRuntimeForTests();
  resetTaskRegistryForTests();
  resetTaskFlowRegistryForTests({ persist: false });
  vi.clearAllMocks();
});

describe("runtime tasks", () => {
  beforeEach(() => {
    setTaskRegistryDeliveryRuntimeForTests({
      sendMessage: hoisted.sendMessageMock,
    });
  });

  it("exposes canonical task and TaskFlow DTOs without leaking raw registry fields", () => {
    const legacyTaskFlow = createRuntimeTaskFlow().bindSession({
      sessionKey: "agent:main:main",
      requesterOrigin: {
        channel: "telegram",
        to: "telegram:123",
      },
    });
    const taskFlows = createRuntimeTaskFlows().bindSession({
      sessionKey: "agent:main:main",
    });
    const taskRuns = createRuntimeTaskRuns().bindSession({
      sessionKey: "agent:main:main",
    });
    const otherTaskFlows = createRuntimeTaskFlows().bindSession({
      sessionKey: "agent:main:other",
    });
    const otherTaskRuns = createRuntimeTaskRuns().bindSession({
      sessionKey: "agent:main:other",
    });

    const created = legacyTaskFlow.createManaged({
      controllerId: "tests/runtime-tasks",
      goal: "Review inbox",
      currentStep: "triage",
      stateJson: { lane: "priority" },
    });
    const child = legacyTaskFlow.runTask({
      flowId: created.flowId,
      runtime: "acp",
      childSessionKey: "agent:main:subagent:child",
      runId: "runtime-task-run",
      label: "Inbox triage",
      task: "Review PR 1",
      status: "running",
      startedAt: 10,
      lastEventAt: 11,
      progressSummary: "Inspecting",
    });
    if (!child.created) {
      throw new Error("expected child task creation to succeed");
    }

    expect(taskFlows.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: created.flowId,
          ownerKey: "agent:main:main",
          goal: "Review inbox",
          currentStep: "triage",
        }),
      ]),
    );
    expect(taskFlows.get(created.flowId)).toMatchObject({
      id: created.flowId,
      ownerKey: "agent:main:main",
      goal: "Review inbox",
      currentStep: "triage",
      state: { lane: "priority" },
      taskSummary: {
        total: 1,
        active: 1,
      },
      tasks: [
        expect.objectContaining({
          id: child.task.taskId,
          flowId: created.flowId,
          title: "Review PR 1",
          label: "Inbox triage",
          runId: "runtime-task-run",
        }),
      ],
    });
    expect(taskRuns.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: child.task.taskId,
          flowId: created.flowId,
          sessionKey: "agent:main:main",
          title: "Review PR 1",
          status: "running",
        }),
      ]),
    );
    expect(taskRuns.get(child.task.taskId)).toMatchObject({
      id: child.task.taskId,
      flowId: created.flowId,
      title: "Review PR 1",
      progressSummary: "Inspecting",
    });
    expect(taskRuns.findLatest()?.id).toBe(child.task.taskId);
    expect(taskRuns.resolve("runtime-task-run")?.id).toBe(child.task.taskId);
    expect(taskFlows.getTaskSummary(created.flowId)).toMatchObject({
      total: 1,
      active: 1,
    });

    expect(otherTaskFlows.get(created.flowId)).toBeUndefined();
    expect(otherTaskRuns.get(child.task.taskId)).toBeUndefined();

    const flowDetail = taskFlows.get(created.flowId);
    expect(flowDetail).not.toHaveProperty("revision");
    expect(flowDetail).not.toHaveProperty("controllerId");
    expect(flowDetail).not.toHaveProperty("syncMode");

    const taskDetail = taskRuns.get(child.task.taskId);
    expect(taskDetail).not.toHaveProperty("taskId");
    expect(taskDetail).not.toHaveProperty("requesterSessionKey");
    expect(taskDetail).not.toHaveProperty("scopeKind");
  });

  it("exposes managed flow resolution hints for retryable and blocked outcomes", () => {
    const legacyTaskFlow = createRuntimeTaskFlow().bindSession({
      sessionKey: "agent:main:main",
    });
    const taskFlows = createRuntimeTaskFlows().bindSession({
      sessionKey: "agent:main:main",
    });

    const blocked = legacyTaskFlow.createManaged({
      controllerId: "tests/runtime-tasks-blocked",
      goal: "Review repository",
    });
    const blockedUpdated = legacyTaskFlow.setWaiting({
      flowId: blocked.flowId,
      expectedRevision: blocked.revision,
      blockedTaskId: "task-1",
      blockedSummary: "Writable session required.",
      waitJson: {
        kind: "child_task",
        runId: "run-blocked",
      },
    });
    expect(blockedUpdated.applied).toBe(true);
    if (!blockedUpdated.applied) {
      throw new Error(`Expected blocked flow update to apply: ${blockedUpdated.code}`);
    }

    const failed = legacyTaskFlow.createManaged({
      controllerId: "tests/runtime-tasks-failed",
      goal: "Investigate CI",
      status: "failed",
      stateJson: {
        completion: {
          status: "timed_out",
        },
      },
    });

    expect(taskFlows.get(blocked.flowId)).toMatchObject({
      resolution: {
        code: "user_action_required",
        retryable: true,
        needsUserAction: true,
        summary: "Needs user action before retrying.",
      },
    });
    expect(taskFlows.get(failed.flowId)).toMatchObject({
      resolution: {
        code: "retry_available",
        retryable: true,
        needsUserAction: false,
        summary: "Retry available.",
      },
    });
  });

  it("maps task cancellation results onto canonical task DTOs", async () => {
    const legacyTaskFlow = createRuntimeTaskFlow().bindSession({
      sessionKey: "agent:main:main",
    });
    const taskRuns = createRuntimeTaskRuns().bindSession({
      sessionKey: "agent:main:main",
    });

    const created = legacyTaskFlow.createManaged({
      controllerId: "tests/runtime-tasks",
      goal: "Cancel active task",
    });
    const child = legacyTaskFlow.runTask({
      flowId: created.flowId,
      runtime: "acp",
      childSessionKey: "agent:main:subagent:child",
      runId: "runtime-task-cancel",
      task: "Cancel me",
      status: "running",
      startedAt: 20,
      lastEventAt: 21,
    });
    if (!child.created) {
      throw new Error("expected child task creation to succeed");
    }

    const result = await taskRuns.cancel({
      taskId: child.task.taskId,
      cfg: {} as never,
    });

    expect(hoisted.cancelSessionMock).toHaveBeenCalledWith({
      cfg: {},
      sessionKey: "agent:main:subagent:child",
      reason: "task-cancel",
    });
    expect(result).toMatchObject({
      found: true,
      cancelled: true,
      task: {
        id: child.task.taskId,
        title: "Cancel me",
        status: "cancelled",
      },
    });
  });

  it("does not allow cross-owner task cancellation or leak task details", async () => {
    const legacyTaskFlow = createRuntimeTaskFlow().bindSession({
      sessionKey: "agent:main:main",
    });
    const otherTaskRuns = createRuntimeTaskRuns().bindSession({
      sessionKey: "agent:main:other",
    });

    const created = legacyTaskFlow.createManaged({
      controllerId: "tests/runtime-tasks",
      goal: "Keep owner isolation",
    });
    const child = legacyTaskFlow.runTask({
      flowId: created.flowId,
      runtime: "acp",
      childSessionKey: "agent:main:subagent:child",
      runId: "runtime-task-isolation",
      task: "Do not cancel me",
      status: "running",
      startedAt: 30,
      lastEventAt: 31,
    });
    if (!child.created) {
      throw new Error("expected child task creation to succeed");
    }

    const result = await otherTaskRuns.cancel({
      taskId: child.task.taskId,
      cfg: {} as never,
    });

    expect(hoisted.cancelSessionMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      found: false,
      cancelled: false,
      reason: "Task not found.",
    });
    expect(otherTaskRuns.get(child.task.taskId)).toBeUndefined();
  });
});
