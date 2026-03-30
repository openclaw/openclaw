import { afterEach, describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
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

describe("task-executor", () => {
  afterEach(() => {
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    resetTaskRegistryForTests();
  });

  it("advances a queued run through start and completion", async () => {
    await withTempDir({ prefix: "openclaw-task-executor-" }, async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

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
    await withTempDir({ prefix: "openclaw-task-executor-" }, async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

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
});
