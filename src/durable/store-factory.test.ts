import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDurableWorkflowStore, resolveDurableWorkflowStoreBackend } from "./store-factory.js";

describe("durable workflow store factory", () => {
  it("opens the SQLite backend by default and satisfies the core store contract", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-factory-"));
    const store = openDurableWorkflowStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const run = store.createRun({
        workflowId: "factory.workflow",
        idempotencyKey: "request-1",
        status: "queued",
        recoveryState: "runnable",
      });
      const step = store.createStep({
        workflowRunId: run.workflowRunId,
        stepType: "tool",
        status: "queued",
        recoveryState: "runnable",
      });
      store.appendEvent({
        workflowRunId: run.workflowRunId,
        stepId: step.stepId,
        eventType: "factory.workflow.accepted",
      });

      const claimed = store.claimNextRunnableStep({
        workflowId: "factory.workflow",
        workerId: "factory-worker",
        claimTtlMs: 1000,
      });

      expect(claimed).toMatchObject({
        workflowRunId: run.workflowRunId,
        stepId: step.stepId,
        claimedBy: "factory-worker",
        recoveryState: "claimed",
      });
      expect(store.getTimeline(run.workflowRunId)).toHaveLength(1);
      expect(store.getStats()).toMatchObject({
        runs: 1,
        steps: 1,
        events: 1,
        openRuns: 1,
      });
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unknown backends with a clear error", () => {
    expect(() =>
      resolveDurableWorkflowStoreBackend({
        OPENCLAW_DURABLE_WORKFLOWS_STORE: "unknown",
      }),
    ).toThrow(/Unsupported durable workflow store backend/);
  });
});
