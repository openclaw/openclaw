import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DURABLE_INTAKE_ENVELOPE_SCHEMA } from "./intake-envelope.js";
import {
  reconcileDurableChatSendsOnGatewayStartup,
  reconcileDueDurableTimers,
  reconcileDurableAgentTurnsOnGatewayStartup,
  reconcileDurableSubagentRunsOnGatewayStartup,
  reconcilePendingDurableSignals,
  reconcileStaleDurableChatSends,
  reconcileStaleDurableAgentTurns,
  reconcileStaleDurableSubagentRuns,
} from "./recovery.js";
import {
  DURABLE_AGENT_TURN_OPERATION_KIND,
  DURABLE_CHAT_SEND_OPERATION_KIND,
  DURABLE_SUBAGENT_RUN_OPERATION_KIND,
} from "./runtime-ids.js";
import { openDurableRuntimeSqliteStore } from "./sqlite-store.js";

describe("durable runtime recovery", () => {
  it("marks running agent turns lost on gateway startup without touching waiting turns", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-recovery-"));
    const store = openDurableRuntimeSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const running = store.createRun({
        operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
        idempotencyKey: "run-running",
        status: "running",
        recoveryState: "running",
        metadata: { sessionKey: "agent:test:running" },
        now: 100,
      });
      const runningStep = store.createStep({
        runtimeRunId: running.runtimeRunId,
        stepId: "agent_invocation",
        stepType: "agent",
        status: "running",
        recoveryState: "running",
        now: 100,
      });
      const waiting = store.createRun({
        operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
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
            runtimeRunId: running.runtimeRunId,
            status: "lost",
            recoveryState: "lost",
            completedAt: 200,
          }),
          expect.objectContaining({
            runtimeRunId: waiting.runtimeRunId,
            status: "waiting",
            recoveryState: "waiting_signal",
          }),
        ]),
      );
      expect(store.getTimeline(running.runtimeRunId).map((event) => event.eventType)).toEqual([
        "agent.turn.lost",
      ]);
      expect(store.listSteps(running.runtimeRunId)).toMatchObject([
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

  it("marks persisted running agent turns lost after the store is reopened", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-recovery-"));
    const dbPath = path.join(dir, "openclaw.sqlite");
    let runningRuntimeRunId = "";
    let runningStepId = "";
    let waitingRuntimeRunId = "";

    const setupStore = openDurableRuntimeSqliteStore({ path: dbPath });
    try {
      const running = setupStore.createRun({
        operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
        idempotencyKey: "run-running-after-restart",
        status: "running",
        recoveryState: "running",
        inputRef: "agent-turn:run-running-after-restart:input",
        metadata: {
          sessionKey: "agent:test:running-after-restart",
          messageHash: "hash-running",
          intakeEnvelope: {
            schema: DURABLE_INTAKE_ENVELOPE_SCHEMA,
            operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
            runId: "run-running-after-restart",
            sourceType: "agent.turn",
            sessionKey: "agent:test:running-after-restart",
            message: {
              length: 18,
              hash: "hash-running",
              preview: "long running turn",
              previewTruncated: false,
            },
            replay: {
              inputAvailability: "preview_only",
              canReplay: false,
              reason: "durable input stores a bounded preview by default",
            },
          },
        },
        now: 100,
      });
      const runningStep = setupStore.createStep({
        runtimeRunId: running.runtimeRunId,
        stepId: "agent_invocation",
        stepType: "agent",
        status: "running",
        recoveryState: "running",
        now: 100,
      });
      const waiting = setupStore.createRun({
        operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
        idempotencyKey: "run-waiting-after-restart",
        status: "waiting",
        recoveryState: "waiting_signal",
        metadata: { sessionKey: "agent:test:waiting-after-restart" },
        now: 100,
      });
      runningRuntimeRunId = running.runtimeRunId;
      runningStepId = runningStep.stepId;
      waitingRuntimeRunId = waiting.runtimeRunId;
    } finally {
      setupStore.close();
    }

    const restartedStore = openDurableRuntimeSqliteStore({ path: dbPath });
    try {
      const result = reconcileDurableAgentTurnsOnGatewayStartup({
        store: restartedStore,
        processInstanceId: "process-after-restart",
        now: 200,
      });

      expect(result).toEqual({ scanned: 2, markedLost: 1 });
      expect(restartedStore.getRun(runningRuntimeRunId)).toMatchObject({
        runtimeRunId: runningRuntimeRunId,
        status: "lost",
        recoveryState: "lost",
        completedAt: 200,
        metadata: {
          sessionKey: "agent:test:running-after-restart",
          recoveryDiagnostic: expect.objectContaining({
            state: "lost",
            reportable: true,
            retryable: true,
            reason: "gateway_startup_reconciliation",
            nextAction: "inspect_timeline_then_retry_or_resume",
            processInstanceId: "process-after-restart",
            input: {
              inputRef: "agent-turn:run-running-after-restart:input",
              inputAvailability: "preview_only",
              canReplay: false,
              reason: "durable input stores a bounded preview by default",
              messageLength: 18,
              messageHash: "hash-running",
            },
            safeRecoveryActions: ["inspect_timeline", "retry_request"],
          }),
        },
      });
      expect(restartedStore.getRun(waitingRuntimeRunId)).toMatchObject({
        runtimeRunId: waitingRuntimeRunId,
        status: "waiting",
        recoveryState: "waiting_signal",
      });
      expect(restartedStore.listSteps(runningRuntimeRunId)).toMatchObject([
        {
          stepId: runningStepId,
          status: "lost",
          recoveryState: "lost",
          completedAt: 200,
          metadata: {
            recoveryDiagnostic: expect.objectContaining({
              state: "lost",
              reason: "gateway_startup_reconciliation",
            }),
          },
        },
      ]);
      expect(restartedStore.getTimeline(runningRuntimeRunId)).toMatchObject([
        {
          eventType: "agent.turn.lost",
          payload: expect.objectContaining({
            processInstanceId: "process-after-restart",
            reason: "gateway_startup_reconciliation",
            recoveryDiagnostic: expect.objectContaining({
              state: "lost",
              nextAction: "inspect_timeline_then_retry_or_resume",
            }),
          }),
        },
      ]);
    } finally {
      restartedStore.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks open chat.send frontdoors lost on gateway startup", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-recovery-"));
    const store = openDurableRuntimeSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const received = store.createRun({
        operationKind: DURABLE_CHAT_SEND_OPERATION_KIND,
        idempotencyKey: "chat-send-open",
        status: "received",
        recoveryState: "runnable",
        sourceRef: "agent:test:main",
        metadata: { sessionKey: "agent:test:main" },
        now: 100,
      });
      store.createStep({
        runtimeRunId: received.runtimeRunId,
        stepId: "intake",
        stepType: "checkpoint",
        status: "queued",
        recoveryState: "runnable",
        now: 100,
      });
      const terminal = store.createRun({
        operationKind: DURABLE_CHAT_SEND_OPERATION_KIND,
        idempotencyKey: "chat-send-terminal",
        status: "succeeded",
        recoveryState: "terminal",
        now: 100,
      });

      const result = reconcileDurableChatSendsOnGatewayStartup({
        store,
        processInstanceId: "process-chat-startup",
        now: 200,
      });

      expect(result).toEqual({ scanned: 1, markedLost: 1 });
      expect(store.getRun(received.runtimeRunId)).toMatchObject({
        status: "lost",
        recoveryState: "lost",
        completedAt: 200,
        metadata: {
          sessionKey: "agent:test:main",
          recoveryDiagnostic: expect.objectContaining({
            state: "lost",
            reason: "gateway_startup_reconciliation",
            nextAction: "inspect_timeline_then_retry_request",
          }),
        },
      });
      expect(store.getRun(terminal.runtimeRunId)).toMatchObject({
        status: "succeeded",
        recoveryState: "terminal",
      });
      expect(store.listSteps(received.runtimeRunId)).toMatchObject([
        {
          stepId: "intake",
          status: "lost",
          recoveryState: "lost",
          completedAt: 200,
        },
      ]);
      expect(store.getTimeline(received.runtimeRunId)).toMatchObject([
        {
          eventType: "chat.send.lost",
          payload: expect.objectContaining({
            processInstanceId: "process-chat-startup",
            reason: "gateway_startup_reconciliation",
          }),
        },
      ]);
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks lost subagent runs terminal and unblocks parent fan-in on gateway startup", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-recovery-"));
    const store = openDurableRuntimeSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const parent = store.createRun({
        operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
        idempotencyKey: "parent-turn",
        status: "waiting_child",
        recoveryState: "waiting_child",
        metadata: { sessionKey: "agent:bo:parent" },
        now: 100,
      });
      store.createStep({
        runtimeRunId: parent.runtimeRunId,
        stepId: "subagents",
        stepType: "fan_in",
        status: "waiting",
        recoveryState: "waiting_child",
        metadata: { policy: "continue_on_child_failure" },
        now: 100,
      });
      const child = store.createRun({
        operationKind: DURABLE_SUBAGENT_RUN_OPERATION_KIND,
        idempotencyKey: "child-run",
        status: "running",
        recoveryState: "running",
        sourceType: "subagent",
        sourceRef: "agent:bo-worker:subagent:child",
        parentRuntimeRunId: parent.runtimeRunId,
        parentStepId: "subagents",
        metadata: { childSessionKey: "agent:bo-worker:subagent:child" },
        now: 100,
      });
      store.createStep({
        runtimeRunId: child.runtimeRunId,
        stepId: "subagent_run",
        stepType: "agent",
        status: "running",
        recoveryState: "running",
        now: 100,
      });
      store.createLink({
        parentRuntimeRunId: parent.runtimeRunId,
        parentStepId: "subagents",
        childRuntimeRunId: child.runtimeRunId,
        linkType: "subagent",
        status: "running",
        metadata: { childSessionKey: "agent:bo-worker:subagent:child" },
        now: 100,
      });

      const result = reconcileDurableSubagentRunsOnGatewayStartup({
        store,
        processInstanceId: "process-subagent-startup",
        now: 200,
      });

      expect(result).toEqual({ scanned: 1, markedLost: 1 });
      expect(store.getRun(child.runtimeRunId)).toMatchObject({
        status: "lost",
        recoveryState: "lost",
        completedAt: 200,
        metadata: {
          childSessionKey: "agent:bo-worker:subagent:child",
          recoveryDiagnostic: expect.objectContaining({
            state: "lost",
            reason: "gateway_startup_reconciliation",
            nextAction: "inspect_timeline_then_retry_child_or_continue_parent",
          }),
        },
      });
      expect(store.listSteps(child.runtimeRunId)).toMatchObject([
        {
          stepId: "subagent_run",
          status: "lost",
          recoveryState: "lost",
          completedAt: 200,
        },
      ]);
      expect(store.listParentLinks(child.runtimeRunId)).toMatchObject([
        {
          parentRuntimeRunId: parent.runtimeRunId,
          parentStepId: "subagents",
          childRuntimeRunId: child.runtimeRunId,
          status: "lost",
          metadata: {
            lostReason: "gateway_startup_reconciliation",
            recoveryDiagnostic: expect.objectContaining({
              state: "lost",
            }),
          },
        },
      ]);
      expect(store.getRun(parent.runtimeRunId)).toMatchObject({
        status: "queued",
        recoveryState: "runnable",
      });
      expect(store.listSteps(parent.runtimeRunId)).toMatchObject([
        {
          stepId: "subagents",
          status: "succeeded",
          recoveryState: "terminal",
          completedAt: 200,
          metadata: {
            total: 1,
            succeeded: 0,
            failed: 1,
            terminal: 1,
          },
        },
      ]);
      expect(store.getTimeline(child.runtimeRunId).at(-1)).toMatchObject({
        eventType: "subagent.run.lost",
        payload: expect.objectContaining({
          processInstanceId: "process-subagent-startup",
          reason: "gateway_startup_reconciliation",
        }),
      });
      expect(store.getTimeline(parent.runtimeRunId).map((event) => event.eventType)).toEqual([
        "subagent.child.lost",
        "fan_in.ready",
      ]);
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks only stale running agent turns lost during periodic recovery", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-recovery-"));
    const store = openDurableRuntimeSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const stale = store.createRun({
        operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
        idempotencyKey: "run-stale",
        status: "running",
        recoveryState: "running",
        metadata: { sessionKey: "agent:test:stale" },
        now: 100,
      });
      const fresh = store.createRun({
        operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
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
            runtimeRunId: stale.runtimeRunId,
            status: "lost",
            recoveryState: "lost",
            completedAt: 2_000,
          }),
          expect.objectContaining({
            runtimeRunId: fresh.runtimeRunId,
            status: "running",
            recoveryState: "running",
          }),
        ]),
      );
      expect(store.getTimeline(stale.runtimeRunId).at(-1)).toMatchObject({
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

  it("marks only stale open chat.send frontdoors lost during periodic recovery", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-recovery-"));
    const store = openDurableRuntimeSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const stale = store.createRun({
        operationKind: DURABLE_CHAT_SEND_OPERATION_KIND,
        idempotencyKey: "chat-send-stale",
        status: "received",
        recoveryState: "runnable",
        metadata: { sessionKey: "agent:test:stale-chat" },
        now: 100,
      });
      const fresh = store.createRun({
        operationKind: DURABLE_CHAT_SEND_OPERATION_KIND,
        idempotencyKey: "chat-send-fresh",
        status: "received",
        recoveryState: "runnable",
        metadata: { sessionKey: "agent:test:fresh-chat" },
        now: 1_900,
      });

      const result = reconcileStaleDurableChatSends({
        store,
        processInstanceId: "process-chat-stale",
        now: 2_000,
        staleAfterMs: 1_000,
      });

      expect(result).toEqual({ scanned: 2, markedLost: 1 });
      expect(store.getRun(stale.runtimeRunId)).toMatchObject({
        status: "lost",
        recoveryState: "lost",
        completedAt: 2_000,
      });
      expect(store.getRun(fresh.runtimeRunId)).toMatchObject({
        status: "received",
        recoveryState: "runnable",
      });
      expect(store.getTimeline(stale.runtimeRunId).at(-1)).toMatchObject({
        eventType: "chat.send.lost",
        payload: expect.objectContaining({
          reason: "stale_chat_send_reconciliation",
        }),
      });
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks only stale running subagent runs lost during periodic recovery", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-recovery-"));
    const store = openDurableRuntimeSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const stale = store.createRun({
        operationKind: DURABLE_SUBAGENT_RUN_OPERATION_KIND,
        idempotencyKey: "subagent-stale",
        status: "running",
        recoveryState: "running",
        metadata: { childSessionKey: "agent:test:stale-subagent" },
        now: 100,
      });
      const fresh = store.createRun({
        operationKind: DURABLE_SUBAGENT_RUN_OPERATION_KIND,
        idempotencyKey: "subagent-fresh",
        status: "running",
        recoveryState: "running",
        metadata: { childSessionKey: "agent:test:fresh-subagent" },
        now: 1_900,
      });

      const result = reconcileStaleDurableSubagentRuns({
        store,
        processInstanceId: "process-subagent-stale",
        now: 2_000,
        staleAfterMs: 1_000,
      });

      expect(result).toEqual({ scanned: 2, markedLost: 1 });
      expect(store.getRun(stale.runtimeRunId)).toMatchObject({
        status: "lost",
        recoveryState: "lost",
        completedAt: 2_000,
      });
      expect(store.getRun(fresh.runtimeRunId)).toMatchObject({
        status: "running",
        recoveryState: "running",
      });
      expect(store.getTimeline(stale.runtimeRunId).at(-1)).toMatchObject({
        eventType: "subagent.run.lost",
        payload: expect.objectContaining({
          reason: "stale_subagent_run_reconciliation",
        }),
      });
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("queues retry-scheduled run and step only when retry timer is due", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-recovery-"));
    const store = openDurableRuntimeSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const run = store.createRun({
        operationKind: "test.runtime",
        idempotencyKey: "run-retry",
        status: "retry_scheduled",
        recoveryState: "retry_scheduled",
        now: 100,
      });
      const step = store.createStep({
        runtimeRunId: run.runtimeRunId,
        stepId: "tool_step",
        stepType: "tool",
        status: "retry_scheduled",
        recoveryState: "retry_scheduled",
        now: 100,
      });
      store.createTimer({
        runtimeRunId: run.runtimeRunId,
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
      expect(store.getRun(run.runtimeRunId)).toMatchObject({
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
      expect(store.getRun(run.runtimeRunId)).toMatchObject({
        status: "queued",
        recoveryState: "runnable",
      });
      expect(store.listSteps(run.runtimeRunId)).toMatchObject([
        {
          stepId: step.stepId,
          status: "queued",
          recoveryState: "runnable",
        },
      ]);
      expect(store.getTimeline(run.runtimeRunId).map((event) => event.eventType)).toEqual([
        "runtime.timer.fired",
        "runtime.retry_due",
      ]);
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("queues waiting signal step when a resume signal is consumed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-recovery-"));
    const store = openDurableRuntimeSqliteStore({
      path: path.join(dir, "openclaw.sqlite"),
    });
    try {
      const run = store.createRun({
        operationKind: "test.runtime",
        idempotencyKey: "run-signal",
        status: "waiting_signal",
        recoveryState: "waiting_signal",
        now: 100,
      });
      const step = store.createStep({
        runtimeRunId: run.runtimeRunId,
        stepId: "approval",
        stepType: "signal",
        status: "waiting",
        recoveryState: "waiting_signal",
        now: 100,
      });
      store.createSignal({
        runtimeRunId: run.runtimeRunId,
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
      expect(store.getRun(run.runtimeRunId)).toMatchObject({
        status: "queued",
        recoveryState: "runnable",
      });
      expect(store.listSteps(run.runtimeRunId)).toMatchObject([
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
