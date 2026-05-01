import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDetachedTaskLifecycleRuntime,
  setDetachedTaskLifecycleRuntime,
} from "../../tasks/detached-task-runtime.js";
import {
  getRuntimeTaskMocks,
  installRuntimeTaskDeliveryMock,
  resetRuntimeTaskTestState,
} from "./runtime-task-test-harness.js";
import { createRuntimeTaskFlow } from "./runtime-taskflow.js";
import { createRuntimeTaskFlows, createRuntimeTaskRuns } from "./runtime-tasks.js";

const runtimeTaskMocks = getRuntimeTaskMocks();

afterEach(() => {
  resetRuntimeTaskTestState();
});

describe("runtime tasks", () => {
  beforeEach(() => {
    installRuntimeTaskDeliveryMock();
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

    expect(runtimeTaskMocks.cancelSessionMock).toHaveBeenCalledWith({
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

  it("routes runtime task cancellation through the detached task runtime seam", async () => {
    const legacyTaskFlow = createRuntimeTaskFlow().bindSession({
      sessionKey: "agent:main:main",
    });
    const taskRuns = createRuntimeTaskRuns().bindSession({
      sessionKey: "agent:main:main",
    });

    const created = legacyTaskFlow.createManaged({
      controllerId: "tests/runtime-tasks",
      goal: "Cancel through runtime seam",
    });
    const child = legacyTaskFlow.runTask({
      flowId: created.flowId,
      runtime: "acp",
      childSessionKey: "agent:main:subagent:child",
      runId: "runtime-task-cancel-seam",
      task: "Cancel via seam",
      status: "running",
      startedAt: 22,
      lastEventAt: 23,
    });
    if (!child.created) {
      throw new Error("expected child task creation to succeed");
    }

    const defaultRuntime = getDetachedTaskLifecycleRuntime();
    const cancelDetachedTaskRunByIdSpy = vi.fn(
      (...args: Parameters<typeof defaultRuntime.cancelDetachedTaskRunById>) =>
        defaultRuntime.cancelDetachedTaskRunById(...args),
    );
    setDetachedTaskLifecycleRuntime({
      ...defaultRuntime,
      cancelDetachedTaskRunById: cancelDetachedTaskRunByIdSpy,
    });

    await taskRuns.cancel({
      taskId: child.task.taskId,
      cfg: {} as never,
    });

    expect(cancelDetachedTaskRunByIdSpy).toHaveBeenCalledWith({
      cfg: {} as never,
      taskId: child.task.taskId,
    });
  });

  it("creates, progresses, and finalizes plugin-owned lifecycle tasks", () => {
    const taskRuns = createRuntimeTaskRuns().bindSession({
      sessionKey: "agent:main:telegram:group:123",
      requesterOrigin: {
        channel: "telegram",
        to: "telegram:123",
        threadId: 456,
      },
    });

    const created = taskRuns.lifecycle.create({
      taskKind: "openclaw-code-agent.session",
      sourceId: "openclaw-code-agent",
      runId: "code-session-1",
      title: "Fix auth race",
      label: "auth-race",
      status: "running",
      startedAt: 100,
      lastEventAt: 101,
      progressSummary: "Launching",
      notifyPolicy: "state_changes",
    });

    expect(created).toMatchObject({
      runtime: "cli",
      taskKind: "openclaw-code-agent.session",
      sourceId: "openclaw-code-agent",
      sessionKey: "agent:main:telegram:group:123",
      ownerKey: "agent:main:telegram:group:123",
      scope: "session",
      runId: "code-session-1",
      title: "Fix auth race",
      label: "auth-race",
      status: "running",
      progressSummary: "Launching",
      notifyPolicy: "state_changes",
    });

    expect(taskRuns.get(created.id)).toMatchObject({
      id: created.id,
      taskKind: "openclaw-code-agent.session",
    });
    expect(taskRuns.resolve("code-session-1")?.id).toBe(created.id);

    const progressed = taskRuns.lifecycle.progress({
      taskKind: "openclaw-code-agent.session",
      runId: "code-session-1",
      lastEventAt: 150,
      progressSummary: "Waiting for plan approval",
      eventSummary: "Waiting for plan approval",
    });
    expect(progressed).toMatchObject({
      id: created.id,
      status: "running",
      lastEventAt: 150,
      progressSummary: "Waiting for plan approval",
    });

    const finalized = taskRuns.lifecycle.finalize({
      taskKind: "openclaw-code-agent.session",
      runId: "code-session-1",
      status: "succeeded",
      endedAt: 200,
      terminalSummary: "Completed",
    });
    expect(finalized).toMatchObject({
      id: created.id,
      status: "succeeded",
      endedAt: 200,
      terminalSummary: "Completed",
    });
  });

  it("makes plugin lifecycle create idempotent by owner, taskKind, and runId", () => {
    const taskRuns = createRuntimeTaskRuns().bindSession({
      sessionKey: "agent:main:main",
    });

    const first = taskRuns.lifecycle.create({
      taskKind: "openclaw-code-agent.session",
      runId: "code-session-idempotent",
      title: "Initial title",
      status: "queued",
      progressSummary: "Queued",
    });
    const second = taskRuns.lifecycle.create({
      taskKind: "openclaw-code-agent.session",
      runId: "code-session-idempotent",
      title: "Updated title",
      label: "updated",
      status: "running",
      startedAt: 300,
      progressSummary: "Running",
    });

    expect(second).toMatchObject({
      id: first.id,
      title: "Updated title",
      label: "updated",
      status: "running",
      progressSummary: "Running",
    });
    expect(
      taskRuns
        .list()
        .filter(
          (task) =>
            task.taskKind === "openclaw-code-agent.session" &&
            task.runId === "code-session-idempotent",
        ),
    ).toHaveLength(1);
  });

  it("scopes plugin lifecycle mutation by owner and taskKind", () => {
    const ownerRuns = createRuntimeTaskRuns().bindSession({
      sessionKey: "agent:main:main",
    });
    const otherRuns = createRuntimeTaskRuns().bindSession({
      sessionKey: "agent:main:other",
    });

    const sessionTask = ownerRuns.lifecycle.create({
      taskKind: "openclaw-code-agent.session",
      runId: "shared-run-id",
      title: "Coding session",
      status: "running",
      progressSummary: "Coding",
    });
    const monitorTask = ownerRuns.lifecycle.create({
      taskKind: "openclaw-code-agent.monitor",
      runId: "shared-run-id",
      title: "Monitor session",
      status: "running",
      progressSummary: "Monitoring",
    });

    expect(
      otherRuns.lifecycle.progress({
        taskKind: "openclaw-code-agent.session",
        runId: "shared-run-id",
        progressSummary: "Cross-owner mutation",
      }),
    ).toBeUndefined();
    expect(
      otherRuns.lifecycle.finalize({
        taskKind: "openclaw-code-agent.session",
        runId: "shared-run-id",
        status: "failed",
        endedAt: 400,
        error: "Cross-owner mutation",
      }),
    ).toBeUndefined();

    const progressed = ownerRuns.lifecycle.progress({
      taskKind: "openclaw-code-agent.session",
      runId: "shared-run-id",
      progressSummary: "Plan approved",
    });
    expect(progressed).toMatchObject({
      id: sessionTask.id,
      progressSummary: "Plan approved",
    });
    expect(ownerRuns.get(monitorTask.id)).toMatchObject({
      id: monitorTask.id,
      progressSummary: "Monitoring",
      status: "running",
    });
    expect(otherRuns.get(sessionTask.id)).toBeUndefined();
  });

  it("does not downgrade stronger terminal plugin lifecycle states", async () => {
    const taskRuns = createRuntimeTaskRuns().bindSession({
      sessionKey: "agent:main:main",
    });
    const created = taskRuns.lifecycle.create({
      taskKind: "openclaw-code-agent.session",
      runId: "terminal-strength",
      title: "Terminal strength",
      status: "running",
    });

    const cancelled = await taskRuns.cancel({
      taskId: created.id,
      cfg: {} as never,
    });
    expect(cancelled).toMatchObject({
      found: true,
      cancelled: true,
      task: {
        id: created.id,
        status: "cancelled",
      },
    });

    expect(
      taskRuns.lifecycle.finalize({
        taskKind: "openclaw-code-agent.session",
        runId: "terminal-strength",
        status: "succeeded",
        endedAt: 500,
        terminalSummary: "Late success",
      }),
    ).toMatchObject({
      id: created.id,
      status: "cancelled",
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

    expect(runtimeTaskMocks.cancelSessionMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      found: false,
      cancelled: false,
      reason: "Task not found.",
    });
    expect(otherTaskRuns.get(child.task.taskId)).toBeUndefined();
  });
});
