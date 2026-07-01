// Runtime task tests cover plugin task runtime registration, invocation, and cleanup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDetachedTaskLifecycleRuntime,
  setDetachedTaskLifecycleRuntime,
} from "../../tasks/detached-task-runtime.js";
import { createTaskRecord } from "../../tasks/task-registry.js";
import { configureTaskRegistryRuntime } from "../../tasks/task-registry.store.js";
import type { TaskDeliveryState, TaskRecord } from "../../tasks/task-registry.types.js";
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

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a non-array record");
  }
  return value as Record<string, unknown>;
}

function requireRecordById(items: readonly unknown[], id: string): Record<string, unknown> {
  for (const item of items) {
    const record = requireRecord(item);
    if (record.id === id) {
      return record;
    }
  }
  throw new Error(`Missing record ${id}`);
}

function requireCreatedFlow<T>(flow: T | null): T {
  if (!flow) {
    throw new Error("expected managed TaskFlow creation to succeed");
  }
  return flow;
}

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

    const created = requireCreatedFlow(
      legacyTaskFlow.createManaged({
        controllerId: "tests/runtime-tasks",
        goal: "Review inbox",
        currentStep: "triage",
        stateJson: { lane: "priority" },
      }),
    );
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

    const listedFlow = requireRecordById(taskFlows.list(), created.flowId);
    expect(listedFlow.ownerKey).toBe("agent:main:main");
    expect(listedFlow.goal).toBe("Review inbox");
    expect(listedFlow.currentStep).toBe("triage");

    const flow = requireRecord(taskFlows.get(created.flowId));
    expect(flow.id).toBe(created.flowId);
    expect(flow.ownerKey).toBe("agent:main:main");
    expect(flow.goal).toBe("Review inbox");
    expect(flow.currentStep).toBe("triage");
    expect(flow.state).toEqual({ lane: "priority" });
    const taskSummary = requireRecord(flow.taskSummary);
    expect(taskSummary.total).toBe(1);
    expect(taskSummary.active).toBe(1);
    const flowTasks = flow.tasks;
    expect(Array.isArray(flowTasks)).toBe(true);
    const flowTask = requireRecordById(flowTasks as unknown[], child.task.taskId);
    expect(flowTask.flowId).toBe(created.flowId);
    expect(flowTask.title).toBe("Review PR 1");
    expect(flowTask.label).toBe("Inbox triage");
    expect(flowTask.runId).toBe("runtime-task-run");

    const listedRun = requireRecordById(taskRuns.list(), child.task.taskId);
    expect(listedRun.flowId).toBe(created.flowId);
    expect(listedRun.sessionKey).toBe("agent:main:main");
    expect(listedRun.title).toBe("Review PR 1");
    expect(listedRun.status).toBe("running");
    const taskRun = requireRecord(taskRuns.get(child.task.taskId));
    expect(taskRun.id).toBe(child.task.taskId);
    expect(taskRun.flowId).toBe(created.flowId);
    expect(taskRun.title).toBe("Review PR 1");
    expect(taskRun.progressSummary).toBe("Inspecting");
    expect(taskRuns.findLatest()?.id).toBe(child.task.taskId);
    expect(taskRuns.resolve("runtime-task-run")?.id).toBe(child.task.taskId);
    const summary = requireRecord(taskFlows.getTaskSummary(created.flowId));
    expect(summary.total).toBe(1);
    expect(summary.active).toBe(1);

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

    const created = requireCreatedFlow(
      legacyTaskFlow.createManaged({
        controllerId: "tests/runtime-tasks",
        goal: "Cancel active task",
      }),
    );
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
    expect(result.found).toBe(true);
    expect(result.cancelled).toBe(true);
    const task = requireRecord(result.task);
    expect(task.id).toBe(child.task.taskId);
    expect(task.title).toBe("Cancel me");
    expect(task.status).toBe("cancelled");
  });

  it("routes runtime task cancellation through the detached task runtime seam", async () => {
    const legacyTaskFlow = createRuntimeTaskFlow().bindSession({
      sessionKey: "agent:main:main",
    });
    const taskRuns = createRuntimeTaskRuns().bindSession({
      sessionKey: "agent:main:main",
    });

    const created = requireCreatedFlow(
      legacyTaskFlow.createManaged({
        controllerId: "tests/runtime-tasks",
        goal: "Cancel through runtime seam",
      }),
    );
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

  it("rejects sourceId lifecycle taskKind shorthand before persistence", () => {
    const taskRuns = createRuntimeTaskRuns().bindSession({
      sessionKey: "agent:main:main",
    });

    expect(() =>
      taskRuns.lifecycle.create({
        taskKind: "session",
        sourceId: "openclaw-code-agent",
        runId: "code-session-shorthand-kind",
        title: "Shorthand kind",
        status: "queued",
      }),
    ).toThrow("Task lifecycle taskKind must be plugin-namespaced");
    expect(taskRuns.list()).toHaveLength(0);
  });

  it("rejects unnamespaced and core lifecycle taskKind values before persistence", () => {
    const taskRuns = createRuntimeTaskRuns().bindSession({
      sessionKey: "agent:main:main",
    });

    expect(() =>
      taskRuns.lifecycle.create({
        taskKind: "codex-native",
        runId: "code-session-core-kind",
        title: "Core kind",
        status: "running",
      }),
    ).toThrow("Task lifecycle taskKind must be plugin-namespaced");
    expect(() =>
      taskRuns.lifecycle.create({
        taskKind: "openclaw.session",
        runId: "code-session-openclaw-kind",
        title: "OpenClaw kind",
        status: "running",
      }),
    ).toThrow("Task lifecycle taskKind must not use a core task namespace");
    expect(taskRuns.list()).toHaveLength(0);
  });

  it("rejects lifecycle taskKind values outside the sourceId namespace", () => {
    const taskRuns = createRuntimeTaskRuns().bindSession({
      sessionKey: "agent:main:main",
    });

    expect(() =>
      taskRuns.lifecycle.create({
        taskKind: "other-plugin.session",
        sourceId: "openclaw-code-agent",
        runId: "code-session-foreign-kind",
        title: "Foreign kind",
        status: "running",
      }),
    ).toThrow("Task lifecycle taskKind must use the sourceId namespace");
    expect(taskRuns.list()).toHaveLength(0);
  });

  it("rejects core lifecycle taskKind values before mutation lookup", () => {
    const taskRuns = createRuntimeTaskRuns().bindSession({
      sessionKey: "agent:main:main",
    });
    const coreTask = createTaskRecord({
      runtime: "cli",
      taskKind: "codex-native",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      runId: "code-session-core-mutation",
      task: "Core task",
      status: "running",
      deliveryStatus: "not_applicable",
      startedAt: 100,
    });
    if (!coreTask) {
      throw new Error("expected core task creation to succeed");
    }

    expect(() =>
      taskRuns.lifecycle.progress({
        taskKind: "codex-native",
        runId: "code-session-core-mutation",
        progressSummary: "Plugin update",
      }),
    ).toThrow("Task lifecycle taskKind must be plugin-namespaced");
    expect(() =>
      taskRuns.lifecycle.finalize({
        taskKind: "codex-native",
        runId: "code-session-core-mutation",
        status: "succeeded",
        endedAt: 200,
      }),
    ).toThrow("Task lifecycle taskKind must be plugin-namespaced");
    const unchanged = taskRuns.get(coreTask.taskId);
    expect(unchanged).toMatchObject({
      id: coreTask.taskId,
      status: "running",
    });
    expect(unchanged?.progressSummary).toBeUndefined();
    expect(unchanged?.endedAt).toBeUndefined();
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
      notifyPolicy: "done_only",
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

  it("throws a controlled error when plugin lifecycle creation cannot persist", () => {
    const upsertTaskWithDeliveryState = vi.fn(
      (_params: { task: TaskRecord; deliveryState?: TaskDeliveryState }) => {
        throw new Error("SQLITE_FULL: database or disk is full");
      },
    );
    configureTaskRegistryRuntime({
      store: {
        loadSnapshot: () => ({
          tasks: new Map(),
          deliveryStates: new Map(),
        }),
        saveSnapshot: () => {},
        upsertTaskWithDeliveryState,
      },
    });
    const taskRuns = createRuntimeTaskRuns().bindSession({
      sessionKey: "agent:main:main",
    });

    expect(() =>
      taskRuns.lifecycle.create({
        taskKind: "openclaw-code-agent.session",
        runId: "create-persist-fail",
        title: "Create while persistence fails",
        status: "running",
      }),
    ).toThrow("Task lifecycle persistence failed.");

    const attempted = upsertTaskWithDeliveryState.mock.calls[0]?.[0]?.task;
    expect(attempted?.taskId).toEqual(expect.any(String));
    expect(taskRuns.get(attempted?.taskId ?? "")).toBeUndefined();
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

  it("keeps plugin lifecycle mutation on lifecycle-created session tasks", () => {
    const taskRuns = createRuntimeTaskRuns().bindSession({
      sessionKey: "agent:main:main",
    });
    const parentLinkedTask = createTaskRecord({
      runtime: "cli",
      taskKind: "openclaw-code-agent.session",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      parentTaskId: "parent-owned-task",
      runId: "shared-plugin-run",
      task: "Parent child task",
      status: "running",
      deliveryStatus: "not_applicable",
      startedAt: 100,
      progressSummary: "Parent progress",
    });
    if (!parentLinkedTask) {
      throw new Error("expected parent-linked task creation to succeed");
    }
    const lifecycleTask = taskRuns.lifecycle.create({
      taskKind: "openclaw-code-agent.session",
      runId: "shared-plugin-run",
      title: "Lifecycle task",
      status: "running",
      progressSummary: "Lifecycle progress",
    });

    const progressed = taskRuns.lifecycle.progress({
      taskKind: "openclaw-code-agent.session",
      runId: "shared-plugin-run",
      progressSummary: "Lifecycle update",
    });
    const finalized = taskRuns.lifecycle.finalize({
      taskKind: "openclaw-code-agent.session",
      runId: "shared-plugin-run",
      status: "succeeded",
      endedAt: 200,
      terminalSummary: "Lifecycle done",
    });

    expect(progressed?.id).toBe(lifecycleTask.id);
    expect(finalized?.id).toBe(lifecycleTask.id);
    expect(finalized).toMatchObject({
      status: "succeeded",
      progressSummary: "Lifecycle update",
      terminalSummary: "Lifecycle done",
    });
    expect(taskRuns.get(parentLinkedTask.taskId)).toMatchObject({
      id: parentLinkedTask.taskId,
      status: "running",
      progressSummary: "Parent progress",
    });
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

    const created = requireCreatedFlow(
      legacyTaskFlow.createManaged({
        controllerId: "tests/runtime-tasks",
        goal: "Keep owner isolation",
      }),
    );
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
