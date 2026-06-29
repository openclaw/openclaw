import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { requestDurableHumanSignal, submitDurableHumanSignal } from "./human-signal.js";
import { reconcilePendingDurableSignals } from "./recovery.js";
import { openDurableWorkflowSqliteStore } from "./sqlite-store.js";

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-human-signal-"));
  const store = openDurableWorkflowSqliteStore({
    path: path.join(dir, "openclaw.sqlite"),
  });
  return {
    store,
    cleanup: () => {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("durable human signal gates", () => {
  it("waits for human input and queues the workflow when a signal arrives", () => {
    const { store, cleanup } = tempStore();
    try {
      const run = store.createRun({
        workflowId: "human.workflow",
        status: "running",
        recoveryState: "running",
        now: 100,
      });
      const waitStep = requestDurableHumanSignal({
        store,
        workflowRunId: run.workflowRunId,
        requestId: "approval-1",
        promptRef: "ref:prompt",
        signalType: "approval",
        now: 110,
      });

      expect(waitStep).toMatchObject({
        stepId: "human:approval-1",
        stepType: "signal",
        status: "waiting",
        recoveryState: "waiting_signal",
        inputRef: "ref:prompt",
      });
      expect(store.getRun(run.workflowRunId)).toMatchObject({
        status: "waiting_signal",
        recoveryState: "waiting_signal",
      });

      const first = submitDurableHumanSignal({
        store,
        workflowRunId: run.workflowRunId,
        stepId: waitStep.stepId,
        signalType: "approval",
        idempotencyKey: "approval-reply-1",
        payloadRef: "ref:approval",
        now: 120,
      });
      const duplicate = submitDurableHumanSignal({
        store,
        workflowRunId: run.workflowRunId,
        stepId: waitStep.stepId,
        signalType: "approval",
        idempotencyKey: "approval-reply-1",
        payloadRef: "ref:approval",
        now: 130,
      });

      expect(first.created).toBe(true);
      expect(duplicate.created).toBe(false);
      expect(duplicate.signal.signalId).toBe(first.signal.signalId);
      expect(store.listPendingSignals()).toHaveLength(1);

      expect(
        reconcilePendingDurableSignals({
          store,
          processInstanceId: "process-1",
          now: 140,
        }),
      ).toEqual({ scanned: 1, markedLost: 0, consumedSignals: 1, queuedRuns: 1 });
      expect(store.getRun(run.workflowRunId)).toMatchObject({
        status: "queued",
        recoveryState: "runnable",
      });
      expect(store.listSteps(run.workflowRunId)).toMatchObject([
        {
          stepId: waitStep.stepId,
          status: "queued",
          recoveryState: "runnable",
        },
      ]);
    } finally {
      cleanup();
    }
  });
});
