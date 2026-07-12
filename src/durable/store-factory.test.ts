import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDurableRuntimeStore } from "./store-factory.js";

describe("durable runtime store factory", () => {
  it("opens the SQLite backend by default and satisfies the core store contract", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-factory-"));
    const store = openDurableRuntimeStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const run = store.createRun({
        operationKind: "factory.runtime",
        idempotencyKey: "request-1",
        status: "queued",
        recoveryState: "runnable",
      });
      const step = store.createStep({
        runtimeRunId: run.runtimeRunId,
        stepType: "tool",
        status: "queued",
        recoveryState: "runnable",
      });
      store.appendEvent({
        runtimeRunId: run.runtimeRunId,
        stepId: step.stepId,
        eventType: "factory.runtime.accepted",
      });

      const claimed = store.claimNextRunnableStep({
        operationKind: "factory.runtime",
        workerId: "factory-worker",
        claimTtlMs: 1000,
      });

      expect(claimed).toMatchObject({
        runtimeRunId: run.runtimeRunId,
        stepId: step.stepId,
        claimedBy: "factory-worker",
        recoveryState: "claimed",
      });
      expect(store.getTimeline(run.runtimeRunId)).toHaveLength(1);
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

});
