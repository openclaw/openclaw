import { afterEach, describe, expect, it, vi } from "vitest";
import { resetAgentEventsForTest, resetAgentRunContextForTest } from "../infra/agent-events.js";
import { resetHeartbeatWakeStateForTests } from "../infra/heartbeat-wake.js";
import { resetSystemEventsForTest } from "../infra/system-events.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  cancelFlowById,
  cancelFlowByIdForOwner,
  cancelDetachedTaskRunById,
  completeTaskRunByRunId,
  createQueuedTaskRun,
  createRunningTaskRun,
  failTaskRunByRunId,
  recordTaskRunProgressByRunId,
  retryBlockedFlowAsQueuedTaskRun,
  retryManagedChildTaskFlow,
  retryManagedChildTaskFlowForOwner,
  runTaskInFlow,
  runTaskInFlowForOwner,
  setDetachedTaskDeliveryStatusByRunId,
  startTaskRunByRunId,
} from "./task-executor.js";
import {
  createManagedTaskFlow,
  getTaskFlowById,
  listTaskFlowRecords,
  resetTaskFlowRegistryForTests,
} from "./task-flow-registry.js";
import {
  setTaskRegistryDeliveryRuntimeForTests,
  getTaskById,
  findLatestTaskForFlowId,
  findTaskByRunId,
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
} from "./task-registry.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
const hoisted = vi.hoisted(() => {
  const sendMessageMock = vi.fn();
  const cancelSessionMock = vi.fn();
  const killSubagentRunAdminMock = vi.fn();
  const spawnSubagentDirectMock = vi.fn(async () => ({
    status: "accepted" as const,
    childSessionKey: "agent:main:subagent:retry-child",
    runId: "run-managed-retry-subagent",
    mode: "run" as const,
  }));
  const spawnAcpDirectMock = vi.fn(async () => ({
    status: "accepted" as const,
    childSessionKey: "agent:codex:acp:retry-child",
    runId: "run-managed-retry-acp",
    mode: "run" as const,
  }));
  return {
    sendMessageMock,
    cancelSessionMock,
    killSubagentRunAdminMock,
    spawnSubagentDirectMock,
    spawnAcpDirectMock,
  };
});

vi.mock("../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    cancelSession: hoisted.cancelSessionMock,
  }),
}));

vi.mock("../agents/subagent-control.js", () => ({
  killSubagentRunAdmin: (params: unknown) => hoisted.killSubagentRunAdminMock(params),
}));

vi.mock("../agents/subagent-spawn.js", () => ({
  spawnSubagentDirect: hoisted.spawnSubagentDirectMock,
}));

vi.mock("../agents/acp-spawn.js", () => ({
  spawnAcpDirect: hoisted.spawnAcpDirectMock,
}));

async function withTaskExecutorStateDir(run: (stateDir: string) => Promise<void>): Promise<void> {
  await withStateDirEnv("openclaw-task-executor-", async ({ stateDir }) => {
    setTaskRegistryDeliveryRuntimeForTests({
      sendMessage: hoisted.sendMessageMock,
    });
    resetSystemEventsForTest();
    resetHeartbeatWakeStateForTests();
    resetAgentEventsForTest();
    resetTaskRegistryDeliveryRuntimeForTests();
    resetAgentRunContextForTest();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    try {
      await run(stateDir);
    } finally {
      resetSystemEventsForTest();
      resetHeartbeatWakeStateForTests();
      resetAgentEventsForTest();
      resetTaskRegistryDeliveryRuntimeForTests();
      resetAgentRunContextForTest();
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
    }
  });
}

describe("task-executor", () => {
  afterEach(() => {
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    resetSystemEventsForTest();
    resetHeartbeatWakeStateForTests();
    resetAgentEventsForTest();
    resetTaskRegistryDeliveryRuntimeForTests();
    resetAgentRunContextForTest();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    hoisted.sendMessageMock.mockReset();
    hoisted.cancelSessionMock.mockReset();
    hoisted.killSubagentRunAdminMock.mockReset();
    hoisted.spawnSubagentDirectMock.mockReset();
    hoisted.spawnAcpDirectMock.mockReset();
  });

  it("advances a queued run through start and completion", async () => {
    await withTaskExecutorStateDir(async () => {
      const created = createQueuedTaskRun({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:codex:acp:child",
        runId: "run-executor-queued",
        task: "Investigate issue",
      });

      expect(created.status).toBe("queued");

      startTaskRunByRunId({
        runId: "run-executor-queued",
        startedAt: 100,
        lastEventAt: 100,
        eventSummary: "Started.",
      });

      completeTaskRunByRunId({
        runId: "run-executor-queued",
        endedAt: 250,
        lastEventAt: 250,
        terminalSummary: "Done.",
      });

      expect(getTaskById(created.taskId)).toMatchObject({
        taskId: created.taskId,
        status: "succeeded",
        startedAt: 100,
        endedAt: 250,
        terminalSummary: "Done.",
      });
    });
  });

  it("records progress, failure, and delivery status through the executor", async () => {
    await withTaskExecutorStateDir(async () => {
      const created = createRunningTaskRun({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:codex:subagent:child",
        runId: "run-executor-fail",
        task: "Write summary",
        startedAt: 10,
      });

      recordTaskRunProgressByRunId({
        runId: "run-executor-fail",
        lastEventAt: 20,
        progressSummary: "Collecting results",
        eventSummary: "Collecting results",
      });

      failTaskRunByRunId({
        runId: "run-executor-fail",
        endedAt: 40,
        lastEventAt: 40,
        error: "tool failed",
      });

      setDetachedTaskDeliveryStatusByRunId({
        runId: "run-executor-fail",
        deliveryStatus: "failed",
      });

      expect(getTaskById(created.taskId)).toMatchObject({
        taskId: created.taskId,
        status: "failed",
        progressSummary: "Collecting results",
        error: "tool failed",
        deliveryStatus: "failed",
      });
    });
  });

  it("auto-creates a one-task flow and keeps it synced with task status", async () => {
    await withTaskExecutorStateDir(async () => {
      const created = createRunningTaskRun({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:codex:subagent:child",
        runId: "run-executor-flow",
        task: "Write summary",
        startedAt: 10,
        deliveryStatus: "pending",
      });

      expect(created.parentFlowId).toEqual(expect.any(String));
      expect(getTaskFlowById(created.parentFlowId!)).toMatchObject({
        flowId: created.parentFlowId,
        ownerKey: "agent:main:main",
        status: "running",
        goal: "Write summary",
        notifyPolicy: "done_only",
      });

      completeTaskRunByRunId({
        runId: "run-executor-flow",
        endedAt: 40,
        lastEventAt: 40,
        terminalSummary: "Done.",
      });

      expect(getTaskFlowById(created.parentFlowId!)).toMatchObject({
        flowId: created.parentFlowId,
        status: "succeeded",
        endedAt: 40,
        goal: "Write summary",
        notifyPolicy: "done_only",
      });
    });
  });

  it("does not auto-create one-task flows for non-returning bookkeeping runs", async () => {
    await withTaskExecutorStateDir(async () => {
      const created = createRunningTaskRun({
        runtime: "cli",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:main:main",
        runId: "run-executor-cli",
        task: "Foreground gateway run",
        deliveryStatus: "not_applicable",
        startedAt: 10,
      });

      expect(created.parentFlowId).toBeUndefined();
      expect(listTaskFlowRecords()).toEqual([]);
    });
  });

  it("records blocked metadata on one-task flows and reuses the same flow for queued retries", async () => {
    await withTaskExecutorStateDir(async () => {
      const created = createRunningTaskRun({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        childSessionKey: "agent:codex:acp:child",
        runId: "run-executor-blocked",
        task: "Patch file",
        startedAt: 10,
        deliveryStatus: "pending",
      });

      completeTaskRunByRunId({
        runId: "run-executor-blocked",
        endedAt: 40,
        lastEventAt: 40,
        terminalOutcome: "blocked",
        terminalSummary: "Writable session required.",
      });

      expect(getTaskById(created.taskId)).toMatchObject({
        taskId: created.taskId,
        status: "succeeded",
        terminalOutcome: "blocked",
        terminalSummary: "Writable session required.",
      });
      expect(getTaskFlowById(created.parentFlowId!)).toMatchObject({
        flowId: created.parentFlowId,
        status: "blocked",
        blockedTaskId: created.taskId,
        blockedSummary: "Writable session required.",
        endedAt: 40,
      });

      const retried = retryBlockedFlowAsQueuedTaskRun({
        flowId: created.parentFlowId!,
        runId: "run-executor-retry",
        childSessionKey: "agent:codex:acp:retry-child",
      });

      expect(retried).toMatchObject({
        found: true,
        retried: true,
        previousTask: expect.objectContaining({
          taskId: created.taskId,
        }),
        task: expect.objectContaining({
          parentFlowId: created.parentFlowId,
          parentTaskId: created.taskId,
          status: "queued",
          runId: "run-executor-retry",
        }),
      });
      expect(getTaskFlowById(created.parentFlowId!)).toMatchObject({
        flowId: created.parentFlowId,
        status: "queued",
      });
      expect(findLatestTaskForFlowId(created.parentFlowId!)).toMatchObject({
        runId: "run-executor-retry",
      });
      expect(findTaskByRunId("run-executor-blocked")).toMatchObject({
        taskId: created.taskId,
        status: "succeeded",
        terminalOutcome: "blocked",
        terminalSummary: "Writable session required.",
      });
    });
  });

  it("retries a failed managed child-task flow by relaunching the stored subagent spawn", async () => {
    await withTaskExecutorStateDir(async () => {
      hoisted.spawnSubagentDirectMock.mockResolvedValue({
        status: "accepted",
        childSessionKey: "agent:main:subagent:retry-child",
        runId: "run-managed-retry-subagent",
        mode: "run",
      });

      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/managed-flow-retry",
        goal: "Inspect PR batch",
        status: "failed",
        currentStep: "failed",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        stateJson: {
          task: "Inspect PR 1",
          runtime: "subagent",
          label: "Inspect PR 1",
          launch: {
            kind: "sessions_spawn_child",
            runtime: "subagent",
            task: "Inspect PR 1",
            label: "Inspect PR 1",
            lane: "verification",
            agentId: "main",
            mode: "run",
          },
        },
        createdAt: 10,
        updatedAt: 20,
        endedAt: 20,
      });

      const retried = await retryManagedChildTaskFlow({
        flowId: flow.flowId,
      });

      expect(retried).toMatchObject({
        found: true,
        retried: true,
        flow: expect.objectContaining({
          flowId: flow.flowId,
          status: "waiting",
          currentStep: "wait_worker",
          retryCount: 1,
          lastRetryAt: expect.any(Number),
        }),
      });
      expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledWith(
        expect.objectContaining({
          task: "Inspect PR 1",
          lane: "verification",
          parentFlowId: flow.flowId,
        }),
        expect.objectContaining({
          agentSessionKey: "agent:main:main",
        }),
      );
      expect(getTaskFlowById(flow.flowId)).toMatchObject({
        status: "waiting",
        retryCount: 1,
        lastRetryAt: expect.any(Number),
        waitJson: expect.objectContaining({
          kind: "child_task",
          runId: "run-managed-retry-subagent",
        }),
      });
    });
  });

  it("retries a lost managed child-task flow by relaunching the stored ACP spawn", async () => {
    await withTaskExecutorStateDir(async () => {
      hoisted.spawnAcpDirectMock.mockResolvedValue({
        status: "accepted",
        childSessionKey: "agent:codex:acp:retry-child",
        runId: "run-managed-retry-acp",
        mode: "run",
      });

      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/managed-flow-retry-acp",
        goal: "Inspect PR batch",
        status: "lost",
        currentStep: "lost",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        stateJson: {
          task: "Inspect PR 3",
          runtime: "acp",
          launch: {
            kind: "sessions_spawn_child",
            runtime: "acp",
            task: "Inspect PR 3",
            agentId: "codex",
            cwd: "/workspace",
          },
        },
        createdAt: 10,
        updatedAt: 20,
        endedAt: 20,
      });

      const retried = await retryManagedChildTaskFlow({
        flowId: flow.flowId,
      });

      expect(retried).toMatchObject({
        found: true,
        retried: true,
        flow: expect.objectContaining({
          flowId: flow.flowId,
          status: "waiting",
          retryCount: 1,
          lastRetryAt: expect.any(Number),
        }),
      });
      expect(hoisted.spawnAcpDirectMock).toHaveBeenCalledWith(
        expect.objectContaining({
          task: "Inspect PR 3",
          agentId: "codex",
          parentFlowId: flow.flowId,
          cwd: "/workspace",
        }),
        expect.objectContaining({
          agentSessionKey: "agent:main:main",
          agentTo: "telegram:123",
        }),
      );
      expect(getTaskFlowById(flow.flowId)).toMatchObject({
        status: "waiting",
        retryCount: 1,
        lastRetryAt: expect.any(Number),
      });
    });
  });

  it("does not retry managed child-task flows whose stored launch used attachments", async () => {
    await withTaskExecutorStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/managed-flow-retry-attachments",
        goal: "Inspect attachment",
        status: "failed",
        currentStep: "failed",
        stateJson: {
          task: "Inspect attachment",
          runtime: "subagent",
          launch: {
            kind: "sessions_spawn_child",
            runtime: "subagent",
            task: "Inspect attachment",
            retryable: false,
            retryReason:
              "Retry unavailable: the original child task used attachments that cannot be safely replayed.",
          },
        },
        createdAt: 10,
        updatedAt: 20,
        endedAt: 20,
      });

      const retried = await retryManagedChildTaskFlow({
        flowId: flow.flowId,
      });

      expect(retried).toMatchObject({
        found: true,
        retried: false,
        reason: expect.stringContaining("used attachments"),
      });
      expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
    });
  });

  it("keeps managed child-task retry owner-scoped", async () => {
    await withTaskExecutorStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/managed-flow-retry-owner",
        goal: "Inspect PR batch",
        status: "failed",
        currentStep: "failed",
        stateJson: {
          task: "Inspect PR 2",
          runtime: "subagent",
        },
        createdAt: 10,
        updatedAt: 20,
        endedAt: 20,
      });

      const retried = await retryManagedChildTaskFlowForOwner({
        flowId: flow.flowId,
        callerOwnerKey: "agent:main:other",
      });

      expect(retried).toMatchObject({
        found: false,
        retried: false,
      });
      expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
    });
  });

  it("cancels active tasks linked to a managed TaskFlow", async () => {
    await withTaskExecutorStateDir(async () => {
      hoisted.cancelSessionMock.mockResolvedValue(undefined);

      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/managed-flow",
        goal: "Inspect PR batch",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
      });
      const child = createRunningTaskRun({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        parentFlowId: flow.flowId,
        childSessionKey: "agent:codex:acp:child",
        runId: "run-linear-cancel",
        task: "Inspect a PR",
        startedAt: 10,
        deliveryStatus: "pending",
      });

      const cancelled = await cancelFlowById({
        cfg: {} as never,
        flowId: flow.flowId,
      });

      expect(cancelled).toMatchObject({
        found: true,
        cancelled: true,
      });
      expect(findTaskByRunId("run-linear-cancel")).toMatchObject({
        taskId: child.taskId,
        status: "cancelled",
      });
      expect(getTaskFlowById(flow.flowId)).toMatchObject({
        flowId: flow.flowId,
        status: "cancelled",
      });
    });
  });

  it("runs child tasks under managed TaskFlows", async () => {
    await withTaskExecutorStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/managed-flow",
        goal: "Inspect PR batch",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
      });

      const created = runTaskInFlow({
        flowId: flow.flowId,
        runtime: "acp",
        childSessionKey: "agent:codex:acp:child",
        runId: "run-flow-child",
        label: "Inspect a PR",
        task: "Inspect a PR",
        status: "running",
        startedAt: 10,
        lastEventAt: 10,
      });

      expect(created).toMatchObject({
        found: true,
        created: true,
        task: expect.objectContaining({
          parentFlowId: flow.flowId,
          ownerKey: "agent:main:main",
          status: "running",
          runId: "run-flow-child",
        }),
      });
      expect(getTaskById(created.task!.taskId)).toMatchObject({
        parentFlowId: flow.flowId,
        ownerKey: "agent:main:main",
        childSessionKey: "agent:codex:acp:child",
      });
    });
  });

  it("completes managed child-task flows when the tracked run succeeds", async () => {
    await withTaskExecutorStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/sessions-spawn-success",
        goal: "Review repository",
        status: "waiting",
        currentStep: "wait_worker",
        stateJson: {
          task: "review repo",
          runtime: "subagent",
          childSessionKey: "agent:main:subagent:child",
          runId: "run-flow-success",
        },
        waitJson: {
          kind: "child_task",
          runtime: "subagent",
          childSessionKey: "agent:main:subagent:child",
          runId: "run-flow-success",
        },
        blockedSummary: "review repo",
      });

      const child = createRunningTaskRun({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        parentFlowId: flow.flowId,
        childSessionKey: "agent:main:subagent:child",
        runId: "run-flow-success",
        task: "review repo",
        startedAt: 10,
      });

      completeTaskRunByRunId({
        runId: "run-flow-success",
        endedAt: 40,
        lastEventAt: 40,
        progressSummary: "Patched the flow manager and tests.",
      });

      expect(getTaskFlowById(flow.flowId)).toMatchObject({
        flowId: flow.flowId,
        status: "succeeded",
        currentStep: "completed",
        waitJson: null,
        blockedSummary: undefined,
        endedAt: 40,
        stateJson: {
          task: "review repo",
          runtime: "subagent",
          childSessionKey: "agent:main:subagent:child",
          runId: "run-flow-success",
          progressSummary: "Patched the flow manager and tests.",
          completion: {
            taskId: child.taskId,
            status: "succeeded",
            childSessionKey: "agent:main:subagent:child",
            runId: "run-flow-success",
            progressSummary: "Patched the flow manager and tests.",
            endedAt: 40,
          },
        },
      });
    });
  });

  it("fails managed child-task flows with completion context on task errors", async () => {
    await withTaskExecutorStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/sessions-spawn-failure",
        goal: "Review repository",
        status: "waiting",
        currentStep: "wait_worker",
        stateJson: {
          task: "review repo",
          runtime: "subagent",
        },
        waitJson: {
          kind: "child_task",
          runtime: "subagent",
          childSessionKey: "agent:main:subagent:child",
          runId: "run-flow-failure",
        },
        blockedSummary: "review repo",
      });

      createRunningTaskRun({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        parentFlowId: flow.flowId,
        childSessionKey: "agent:main:subagent:child",
        runId: "run-flow-failure",
        task: "review repo",
        startedAt: 10,
      });

      failTaskRunByRunId({
        runId: "run-flow-failure",
        status: "timed_out",
        endedAt: 55,
        lastEventAt: 55,
        error: "Timed out waiting for test results.",
        progressSummary: "Tests were still running.",
      });

      expect(getTaskFlowById(flow.flowId)).toMatchObject({
        flowId: flow.flowId,
        status: "failed",
        currentStep: "failed",
        waitJson: null,
        blockedSummary: "Timed out waiting for test results.",
        endedAt: 55,
        stateJson: {
          task: "review repo",
          runtime: "subagent",
          progressSummary: "Tests were still running.",
          completion: {
            status: "timed_out",
            childSessionKey: "agent:main:subagent:child",
            runId: "run-flow-failure",
            progressSummary: "Tests were still running.",
            error: "Timed out waiting for test results.",
            endedAt: 55,
          },
        },
      });
    });
  });

  it("marks managed child-task flows blocked when the tracked run ends blocked", async () => {
    await withTaskExecutorStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/sessions-spawn-blocked",
        goal: "Review repository",
        status: "waiting",
        currentStep: "wait_worker",
        waitJson: {
          kind: "child_task",
          runtime: "subagent",
          childSessionKey: "agent:main:subagent:child",
          runId: "run-flow-blocked",
        },
      });

      createRunningTaskRun({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        parentFlowId: flow.flowId,
        childSessionKey: "agent:main:subagent:child",
        runId: "run-flow-blocked",
        task: "review repo",
        startedAt: 10,
      });

      completeTaskRunByRunId({
        runId: "run-flow-blocked",
        endedAt: 60,
        lastEventAt: 60,
        progressSummary: "Waiting for workspace approval.",
        terminalSummary: "Writable session required.",
        terminalOutcome: "blocked",
      });

      expect(getTaskFlowById(flow.flowId)).toMatchObject({
        flowId: flow.flowId,
        status: "blocked",
        currentStep: "blocked",
        waitJson: null,
        blockedTaskId: expect.any(String),
        blockedSummary: "Writable session required.",
        endedAt: 60,
        stateJson: {
          completion: {
            status: "succeeded",
            terminalOutcome: "blocked",
            childSessionKey: "agent:main:subagent:child",
            runId: "run-flow-blocked",
            progressSummary: "Waiting for workspace approval.",
            terminalSummary: "Writable session required.",
            endedAt: 60,
          },
        },
      });
    });
  });

  it("marks managed child-task flows cancelled when the tracked run is cancelled", async () => {
    await withTaskExecutorStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/sessions-spawn-cancelled",
        goal: "Review repository",
        status: "waiting",
        currentStep: "wait_worker",
        waitJson: {
          kind: "child_task",
          runtime: "subagent",
          childSessionKey: "agent:main:subagent:child",
          runId: "run-flow-cancelled",
        },
      });

      createRunningTaskRun({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        parentFlowId: flow.flowId,
        childSessionKey: "agent:main:subagent:child",
        runId: "run-flow-cancelled",
        task: "review repo",
        startedAt: 10,
      });

      failTaskRunByRunId({
        runId: "run-flow-cancelled",
        status: "cancelled",
        endedAt: 65,
        lastEventAt: 65,
        error: "Cancelled by the requester.",
      });

      expect(getTaskFlowById(flow.flowId)).toMatchObject({
        flowId: flow.flowId,
        status: "cancelled",
        currentStep: "cancelled",
        waitJson: null,
        blockedSummary: "Cancelled by the requester.",
        endedAt: 65,
        stateJson: {
          completion: {
            status: "cancelled",
            childSessionKey: "agent:main:subagent:child",
            runId: "run-flow-cancelled",
            error: "Cancelled by the requester.",
            endedAt: 65,
          },
        },
      });
    });
  });

  it("leaves unrelated managed flows open when they are not waiting on a child task", async () => {
    await withTaskExecutorStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/manual-managed-flow",
        goal: "Manual orchestration",
        status: "waiting",
        currentStep: "external_event",
        waitJson: {
          kind: "external_event",
          source: "operator",
        },
      });

      createRunningTaskRun({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        parentFlowId: flow.flowId,
        childSessionKey: "agent:main:subagent:child",
        runId: "run-unrelated-managed-flow",
        task: "review repo",
        startedAt: 10,
      });

      completeTaskRunByRunId({
        runId: "run-unrelated-managed-flow",
        endedAt: 70,
        lastEventAt: 70,
        progressSummary: "Done.",
      });

      expect(getTaskFlowById(flow.flowId)).toMatchObject({
        flowId: flow.flowId,
        status: "waiting",
        currentStep: "external_event",
        waitJson: {
          kind: "external_event",
          source: "operator",
        },
      });
    });
  });

  it("refuses to add child tasks once cancellation is requested on a managed TaskFlow", async () => {
    await withTaskExecutorStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/managed-flow",
        goal: "Protected flow",
      });

      const cancelled = await cancelFlowById({
        cfg: {} as never,
        flowId: flow.flowId,
      });

      expect(cancelled).toMatchObject({
        found: true,
        cancelled: true,
      });

      const created = runTaskInFlow({
        flowId: flow.flowId,
        runtime: "acp",
        childSessionKey: "agent:codex:acp:child",
        runId: "run-flow-after-cancel",
        task: "Should be denied",
      });

      expect(created).toMatchObject({
        found: true,
        created: false,
        reason: "Flow cancellation has already been requested.",
      });
    });
  });

  it("sets cancel intent before child tasks settle and finalizes later", async () => {
    await withTaskExecutorStateDir(async () => {
      hoisted.cancelSessionMock.mockRejectedValue(new Error("still shutting down"));

      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/managed-flow",
        goal: "Long running batch",
      });
      const child = runTaskInFlow({
        flowId: flow.flowId,
        runtime: "acp",
        childSessionKey: "agent:codex:acp:child",
        runId: "run-flow-sticky-cancel",
        task: "Inspect a PR",
        status: "running",
        startedAt: 10,
        lastEventAt: 10,
      }).task!;

      const cancelled = await cancelFlowById({
        cfg: {} as never,
        flowId: flow.flowId,
      });

      expect(cancelled).toMatchObject({
        found: true,
        cancelled: false,
        reason: "One or more child tasks are still active.",
        flow: expect.objectContaining({
          flowId: flow.flowId,
          cancelRequestedAt: expect.any(Number),
          status: "queued",
        }),
      });

      failTaskRunByRunId({
        runId: "run-flow-sticky-cancel",
        endedAt: 50,
        lastEventAt: 50,
        error: "cancel completed later",
        status: "cancelled",
      });

      expect(getTaskById(child.taskId)).toMatchObject({
        taskId: child.taskId,
        status: "cancelled",
      });
      expect(getTaskFlowById(flow.flowId)).toMatchObject({
        flowId: flow.flowId,
        cancelRequestedAt: expect.any(Number),
        status: "cancelled",
        endedAt: 50,
      });
    });
  });

  it("denies cross-owner flow cancellation through the owner-scoped wrapper", async () => {
    await withTaskExecutorStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/managed-flow",
        goal: "Protected flow",
      });

      const cancelled = await cancelFlowByIdForOwner({
        cfg: {} as never,
        flowId: flow.flowId,
        callerOwnerKey: "agent:main:other",
      });

      expect(cancelled).toMatchObject({
        found: false,
        cancelled: false,
        reason: "Flow not found.",
      });
      expect(getTaskFlowById(flow.flowId)).toMatchObject({
        flowId: flow.flowId,
        status: "queued",
      });
    });
  });

  it("denies cross-owner managed TaskFlow child spawning through the owner-scoped wrapper", async () => {
    await withTaskExecutorStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/managed-flow",
        goal: "Protected flow",
      });

      const created = runTaskInFlowForOwner({
        flowId: flow.flowId,
        callerOwnerKey: "agent:main:other",
        runtime: "acp",
        childSessionKey: "agent:codex:acp:child",
        runId: "run-flow-cross-owner",
        task: "Should be denied",
      });

      expect(created).toMatchObject({
        found: false,
        created: false,
        reason: "Flow not found.",
      });
      expect(findLatestTaskForFlowId(flow.flowId)).toBeUndefined();
    });
  });

  it("cancels active ACP child tasks", async () => {
    await withTaskExecutorStateDir(async () => {
      hoisted.cancelSessionMock.mockResolvedValue(undefined);

      const child = createRunningTaskRun({
        runtime: "acp",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:codex:acp:child",
        runId: "run-linear-cancel",
        task: "Inspect a PR",
        startedAt: 10,
        deliveryStatus: "pending",
      });

      const cancelled = await cancelDetachedTaskRunById({
        cfg: {} as never,
        taskId: child.taskId,
      });

      expect(cancelled).toMatchObject({
        found: true,
        cancelled: true,
      });
      expect(getTaskById(child.taskId)).toMatchObject({
        taskId: child.taskId,
        status: "cancelled",
      });
      expect(hoisted.cancelSessionMock).toHaveBeenCalledWith({
        cfg: {} as never,
        sessionKey: "agent:codex:acp:child",
        reason: "task-cancel",
      });
    });
  });

  it("cancels active subagent child tasks", async () => {
    await withTaskExecutorStateDir(async () => {
      hoisted.killSubagentRunAdminMock.mockResolvedValue({
        found: true,
        killed: true,
      });

      const child = createRunningTaskRun({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:codex:subagent:child",
        runId: "run-subagent-cancel",
        task: "Inspect a PR",
        startedAt: 10,
        deliveryStatus: "pending",
      });

      const cancelled = await cancelDetachedTaskRunById({
        cfg: {} as never,
        taskId: child.taskId,
      });

      expect(cancelled).toMatchObject({
        found: true,
        cancelled: true,
      });
      expect(getTaskById(child.taskId)).toMatchObject({
        taskId: child.taskId,
        status: "cancelled",
      });
      expect(hoisted.killSubagentRunAdminMock).toHaveBeenCalledWith({
        cfg: {} as never,
        sessionKey: "agent:codex:subagent:child",
      });
    });
  });

  it("scopes run-id updates to the matching runtime and session", async () => {
    await withTaskExecutorStateDir(async () => {
      const victim = createRunningTaskRun({
        runtime: "acp",
        ownerKey: "agent:victim:main",
        scopeKind: "session",
        childSessionKey: "agent:victim:acp:child",
        runId: "run-shared-executor-scope",
        task: "Victim ACP task",
        deliveryStatus: "pending",
      });
      const attacker = createRunningTaskRun({
        runtime: "cli",
        ownerKey: "agent:attacker:main",
        scopeKind: "session",
        childSessionKey: "agent:attacker:main",
        runId: "run-shared-executor-scope",
        task: "Attacker CLI task",
        deliveryStatus: "not_applicable",
      });

      failTaskRunByRunId({
        runId: "run-shared-executor-scope",
        runtime: "cli",
        sessionKey: "agent:attacker:main",
        endedAt: 40,
        lastEventAt: 40,
        error: "attacker controlled error",
      });

      expect(getTaskById(attacker.taskId)).toMatchObject({
        status: "failed",
        error: "attacker controlled error",
      });
      expect(getTaskById(victim.taskId)).toMatchObject({
        status: "running",
      });
    });
  });
});
