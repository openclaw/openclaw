import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  getFlowById,
  listFlowRecords,
  resetFlowRegistryForTests,
  updateFlowRecordById,
} from "./flow-registry.js";
import {
  cancelFlowById,
  completeTaskRunByRunId,
  createLinearFlow,
  createQueuedTaskRun,
  createRunningTaskRun,
  failTaskRunByRunId,
  recordTaskRunProgressByRunId,
  retryBlockedFlowAsQueuedTaskRun,
  retryBlockedFlowAsRunningTaskRun,
  setDetachedTaskDeliveryStatusByRunId,
  startTaskRunByRunId,
} from "./task-executor.js";
import {
  findLatestTaskForFlowId,
  findTaskByRunId,
  resetTaskRegistryForTests,
} from "./task-registry.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
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

vi.mock("./task-registry-delivery-runtime.js", () => ({
  sendMessage: hoisted.sendMessageMock,
}));

vi.mock("../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    cancelSession: hoisted.cancelSessionMock,
  }),
}));

vi.mock("../agents/subagent-control.js", () => ({
  killSubagentRunAdmin: (params: unknown) => hoisted.killSubagentRunAdminMock(params),
}));

async function withTaskExecutorStateDir(run: (root: string) => Promise<void>): Promise<void> {
  await withTempDir({ prefix: "openclaw-task-executor-" }, async (root) => {
    process.env.OPENCLAW_STATE_DIR = root;
    resetTaskRegistryForTests();
    resetFlowRegistryForTests();
    try {
      await run(root);
    } finally {
      resetTaskRegistryForTests();
      resetFlowRegistryForTests();
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
    resetTaskRegistryForTests();
    resetFlowRegistryForTests();
    hoisted.sendMessageMock.mockReset();
    hoisted.cancelSessionMock.mockReset();
    hoisted.killSubagentRunAdminMock.mockReset();
  });

  it("advances a queued run through start and completion", async () => {
    await withTaskExecutorStateDir(async () => {
      const created = createQueuedTaskRun({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
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

      expect(findTaskByRunId("run-executor-queued")).toMatchObject({
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
        requesterSessionKey: "agent:main:main",
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

      expect(findTaskByRunId("run-executor-fail")).toMatchObject({
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
        requesterSessionKey: "agent:main:main",
        childSessionKey: "agent:codex:subagent:child",
        runId: "run-executor-flow",
        task: "Write summary",
        startedAt: 10,
        deliveryStatus: "pending",
      });

      expect(created.parentFlowId).toEqual(expect.any(String));
      expect(getFlowById(created.parentFlowId!)).toMatchObject({
        flowId: created.parentFlowId,
        ownerSessionKey: "agent:main:main",
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

      expect(getFlowById(created.parentFlowId!)).toMatchObject({
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
        requesterSessionKey: "agent:main:main",
        childSessionKey: "agent:main:main",
        runId: "run-executor-cli",
        task: "Foreground gateway run",
        deliveryStatus: "not_applicable",
        startedAt: 10,
      });

      expect(created.parentFlowId).toBeUndefined();
      expect(listFlowRecords()).toEqual([]);
    });
  });

  it("records blocked metadata on one-task flows and reuses the same flow for queued retries", async () => {
    await withTaskExecutorStateDir(async () => {
      const created = createRunningTaskRun({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
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

      expect(getFlowById(created.parentFlowId!)).toMatchObject({
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

      expect(getFlowById(created.parentFlowId!)).toMatchObject({
        flowId: created.parentFlowId,
        status: "queued",
      });
      expect(getFlowById(created.parentFlowId!)?.blockedTaskId).toBeUndefined();
      expect(getFlowById(created.parentFlowId!)?.blockedSummary).toBeUndefined();
      expect(getFlowById(created.parentFlowId!)?.endedAt).toBeUndefined();
      expect(findLatestTaskForFlowId(created.parentFlowId!)).toMatchObject({
        taskId: retried.task?.taskId,
      });
    });
  });

  it("can reopen blocked one-task flows directly into a running retry", async () => {
    await withTaskExecutorStateDir(async () => {
      const created = createRunningTaskRun({
        runtime: "subagent",
        requesterSessionKey: "agent:main:main",
        childSessionKey: "agent:codex:subagent:child",
        runId: "run-executor-blocked-running",
        task: "Write summary",
        startedAt: 10,
        deliveryStatus: "pending",
      });

      completeTaskRunByRunId({
        runId: "run-executor-blocked-running",
        endedAt: 40,
        lastEventAt: 40,
        terminalOutcome: "blocked",
        terminalSummary: "Need write approval.",
      });

      const retried = retryBlockedFlowAsRunningTaskRun({
        flowId: created.parentFlowId!,
        runId: "run-executor-running-retry",
        childSessionKey: "agent:codex:subagent:retry",
        startedAt: 55,
        lastEventAt: 55,
        progressSummary: "Retrying with approval",
      });

      expect(retried).toMatchObject({
        found: true,
        retried: true,
        task: expect.objectContaining({
          parentFlowId: created.parentFlowId,
          status: "running",
          runId: "run-executor-running-retry",
          progressSummary: "Retrying with approval",
        }),
      });

      expect(getFlowById(created.parentFlowId!)).toMatchObject({
        flowId: created.parentFlowId,
        status: "running",
      });
    });
  });

  it("refuses to retry flows that are not currently blocked", async () => {
    await withTaskExecutorStateDir(async () => {
      const created = createRunningTaskRun({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        childSessionKey: "agent:codex:acp:child",
        runId: "run-executor-not-blocked",
        task: "Patch file",
        startedAt: 10,
        deliveryStatus: "pending",
      });

      const retried = retryBlockedFlowAsQueuedTaskRun({
        flowId: created.parentFlowId!,
        runId: "run-should-not-exist",
      });

      expect(retried).toMatchObject({
        found: true,
        retried: false,
        reason: "Flow is not blocked.",
      });
      expect(findTaskByRunId("run-should-not-exist")).toBeUndefined();
    });
  });

  it("keeps linear flows under explicit control instead of auto-syncing child task status", async () => {
    await withTaskExecutorStateDir(async () => {
      const flow = createLinearFlow({
        ownerSessionKey: "agent:main:main",
        goal: "Triage a PR cluster",
        currentStep: "wait_for",
        notifyPolicy: "done_only",
      });

      const child = createRunningTaskRun({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
        parentFlowId: flow.flowId,
        childSessionKey: "agent:codex:acp:child",
        runId: "run-linear-child",
        task: "Inspect a PR",
        startedAt: 10,
        deliveryStatus: "pending",
      });

      completeTaskRunByRunId({
        runId: "run-linear-child",
        endedAt: 40,
        lastEventAt: 40,
        terminalSummary: "Done.",
      });

      expect(child.parentFlowId).toBe(flow.flowId);
      expect(getFlowById(flow.flowId)).toMatchObject({
        flowId: flow.flowId,
        shape: "linear",
        status: "queued",
        currentStep: "wait_for",
      });
    });
  });

  it("cancels active child tasks and marks a linear flow cancelled", async () => {
    await withTaskExecutorStateDir(async () => {
      hoisted.cancelSessionMock.mockResolvedValue(undefined);

      const flow = createLinearFlow({
        ownerSessionKey: "agent:main:main",
        goal: "Cluster related PRs",
        currentStep: "wait_for",
      });

      const child = createRunningTaskRun({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
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
        flow: expect.objectContaining({
          flowId: flow.flowId,
          status: "cancelled",
        }),
      });
      expect(findTaskByRunId("run-linear-cancel")).toMatchObject({
        taskId: child.taskId,
        status: "cancelled",
      });
      expect(getFlowById(flow.flowId)).toMatchObject({
        flowId: flow.flowId,
        status: "cancelled",
      });
      expect(hoisted.cancelSessionMock).toHaveBeenCalled();
    });
  });

  it("refuses to rewrite terminal linear flows when cancel is requested", async () => {
    await withTaskExecutorStateDir(async () => {
      const flow = createLinearFlow({
        ownerSessionKey: "agent:main:main",
        goal: "Cluster related PRs",
        currentStep: "finish",
      });
      updateFlowRecordById(flow.flowId, {
        status: "succeeded",
        endedAt: 55,
        updatedAt: 55,
      });

      const cancelled = await cancelFlowById({
        cfg: {} as never,
        flowId: flow.flowId,
      });

      expect(cancelled).toMatchObject({
        found: true,
        cancelled: false,
        reason: "Flow is already succeeded.",
      });
      expect(getFlowById(flow.flowId)).toMatchObject({
        flowId: flow.flowId,
        status: "succeeded",
        endedAt: 55,
      });
    });
  });
});
