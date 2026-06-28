import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  reconcileDueDurableTimers,
  reconcileDurableAgentTurnsOnGatewayStartup,
  reconcilePendingDurableSignals,
  reconcileStaleDurableAgentTurns,
} from "./recovery.js";
import { openDurableWorkflowSqliteStore } from "./sqlite-store.js";
import { DURABLE_AGENT_TURN_WORKFLOW_ID } from "./workflow-ids.js";

describe("durable workflow recovery", () => {
  it("marks running agent turns lost on gateway startup without touching waiting turns", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-recovery-"));
    const store = openDurableWorkflowSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const running = store.createRun({
        workflowId: DURABLE_AGENT_TURN_WORKFLOW_ID,
        idempotencyKey: "run-running",
        status: "running",
        recoveryState: "running",
        metadata: { sessionKey: "agent:test:running" },
        now: 100,
      });
      const runningStep = store.createStep({
        workflowRunId: running.workflowRunId,
        stepId: "agent_invocation",
        stepType: "agent",
        status: "running",
        recoveryState: "running",
        now: 100,
      });
      const waiting = store.createRun({
        workflowId: DURABLE_AGENT_TURN_WORKFLOW_ID,
        idempotencyKey: "run-waiting",
        status: "waiting",
        recoveryState: "waiting_signal",
        metadata: { sessionKey: "agent:test:waiting" },
        now: 100,
      });

      const result = reconcileDurableAgentTurnsOnGatewayStartup({
        store,
        processInstanceId: "process-1",
        now: 200,
      });

      expect(result).toEqual({ scanned: 2, markedLost: 1 });
      expect(store.listRuns({ limit: 10 })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            workflowRunId: running.workflowRunId,
            status: "lost",
            recoveryState: "lost",
            completedAt: 200,
          }),
          expect.objectContaining({
            workflowRunId: waiting.workflowRunId,
            status: "waiting",
            recoveryState: "waiting_signal",
          }),
        ]),
      );
      expect(store.getTimeline(running.workflowRunId).map((event) => event.eventType)).toEqual([
        "agent.turn.lost",
      ]);
      expect(store.listSteps(running.workflowRunId)).toMatchObject([
        {
          stepId: runningStep.stepId,
          status: "lost",
          recoveryState: "lost",
          completedAt: 200,
        },
      ]);
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks only stale running agent turns lost during periodic recovery", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-recovery-"));
    const store = openDurableWorkflowSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const stale = store.createRun({
        workflowId: DURABLE_AGENT_TURN_WORKFLOW_ID,
        idempotencyKey: "run-stale",
        status: "running",
        recoveryState: "running",
        metadata: { sessionKey: "agent:test:stale" },
        now: 100,
      });
      const fresh = store.createRun({
        workflowId: DURABLE_AGENT_TURN_WORKFLOW_ID,
        idempotencyKey: "run-fresh",
        status: "running",
        recoveryState: "running",
        metadata: { sessionKey: "agent:test:fresh" },
        now: 1_900,
      });

      const result = reconcileStaleDurableAgentTurns({
        store,
        processInstanceId: "process-1",
        now: 2_000,
        staleAfterMs: 1_000,
      });

      expect(result).toEqual({ scanned: 2, markedLost: 1 });
      expect(store.listRuns({ limit: 10 })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            workflowRunId: stale.workflowRunId,
            status: "lost",
            recoveryState: "lost",
            completedAt: 2_000,
          }),
          expect.objectContaining({
            workflowRunId: fresh.workflowRunId,
            status: "running",
            recoveryState: "running",
          }),
        ]),
      );
      expect(store.getTimeline(stale.workflowRunId).at(-1)).toMatchObject({
        eventType: "agent.turn.lost",
        payload: expect.objectContaining({
          reason: "stale_agent_turn_reconciliation",
        }),
      });
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("queues retry-scheduled run and step only when retry timer is due", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-recovery-"));
    const store = openDurableWorkflowSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const run = store.createRun({
        workflowId: "test.workflow",
        idempotencyKey: "run-retry",
        status: "retry_scheduled",
        recoveryState: "retry_scheduled",
        now: 100,
      });
      const step = store.createStep({
        workflowRunId: run.workflowRunId,
        stepId: "tool_step",
        stepType: "tool",
        status: "retry_scheduled",
        recoveryState: "retry_scheduled",
        now: 100,
      });
      store.createTimer({
        workflowRunId: run.workflowRunId,
        stepId: step.stepId,
        timerType: "retry",
        dueAt: 1_000,
        now: 100,
      });

      expect(
        reconcileDueDurableTimers({
          store,
          processInstanceId: "process-1",
          now: 999,
        }),
      ).toEqual({ scanned: 0, markedLost: 0, firedTimers: 0, queuedRuns: 0 });
      expect(store.getRun(run.workflowRunId)).toMatchObject({
        status: "retry_scheduled",
        recoveryState: "retry_scheduled",
      });

      expect(
        reconcileDueDurableTimers({
          store,
          processInstanceId: "process-1",
          now: 1_000,
        }),
      ).toEqual({ scanned: 1, markedLost: 0, firedTimers: 1, queuedRuns: 1 });
      expect(store.getRun(run.workflowRunId)).toMatchObject({
        status: "queued",
        recoveryState: "runnable",
      });
      expect(store.listSteps(run.workflowRunId)).toMatchObject([
        {
          stepId: step.stepId,
          status: "queued",
          recoveryState: "runnable",
        },
      ]);
      expect(store.getTimeline(run.workflowRunId).map((event) => event.eventType)).toEqual([
        "workflow.timer.fired",
        "workflow.retry_due",
      ]);
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("queues waiting signal step when a resume signal is consumed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-recovery-"));
    const store = openDurableWorkflowSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const run = store.createRun({
        workflowId: "test.workflow",
        idempotencyKey: "run-signal",
        status: "waiting_signal",
        recoveryState: "waiting_signal",
        now: 100,
      });
      const step = store.createStep({
        workflowRunId: run.workflowRunId,
        stepId: "approval",
        stepType: "signal",
        status: "waiting",
        recoveryState: "waiting_signal",
        now: 100,
      });
      store.createSignal({
        workflowRunId: run.workflowRunId,
        stepId: step.stepId,
        signalType: "resume",
        idempotencyKey: "resume-1",
        now: 200,
      });

      expect(
        reconcilePendingDurableSignals({
          store,
          processInstanceId: "process-1",
          now: 300,
        }),
      ).toEqual({ scanned: 1, markedLost: 0, consumedSignals: 1, queuedRuns: 1 });
      expect(store.getRun(run.workflowRunId)).toMatchObject({
        status: "queued",
        recoveryState: "runnable",
      });
      expect(store.listSteps(run.workflowRunId)).toMatchObject([
        {
          stepId: step.stepId,
          status: "queued",
          recoveryState: "runnable",
        },
      ]);
      expect(store.listPendingSignals()).toEqual([]);
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
