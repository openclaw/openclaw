import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  cancelDetachedTaskRunById,
  completeTaskRunByRunId,
  createQueuedTaskRun,
  createRunningTaskRun,
  failTaskRunByRunId,
  recordTaskRunProgressByRunId,
  setDetachedTaskDeliveryStatusByRunId,
  startTaskRunByRunId,
} from "./task-executor.js";
import { findTaskByRunId, resetTaskRegistryForTests } from "./task-registry.js";

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
    try {
      await run(root);
    } finally {
      resetTaskRegistryForTests();
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

  it("records blocked task outcomes without wrapping them in a separate flow model", async () => {
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
        notifyPolicy: "silent",
      });

      completeTaskRunByRunId({
        runId: "run-executor-blocked",
        endedAt: 40,
        lastEventAt: 40,
        terminalOutcome: "blocked",
        terminalSummary: "Writable session required.",
      });

      expect(findTaskByRunId("run-executor-blocked")).toMatchObject({
        taskId: created.taskId,
        status: "succeeded",
        terminalOutcome: "blocked",
        terminalSummary: "Writable session required.",
      });
    });
  });

  it("cancels active ACP child tasks", async () => {
    await withTaskExecutorStateDir(async () => {
      hoisted.cancelSessionMock.mockResolvedValue(undefined);

      const child = createRunningTaskRun({
        runtime: "acp",
        requesterSessionKey: "agent:main:main",
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
      expect(findTaskByRunId("run-linear-cancel")).toMatchObject({
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
        requesterSessionKey: "agent:main:main",
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
      expect(findTaskByRunId("run-subagent-cancel")).toMatchObject({
        taskId: child.taskId,
        status: "cancelled",
      });
      expect(hoisted.killSubagentRunAdminMock).toHaveBeenCalledWith({
        cfg: {} as never,
        sessionKey: "agent:codex:subagent:child",
      });
    });
  });
});
