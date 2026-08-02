import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveDurableRuntimeSqlitePath } from "./config.js";
import {
  reconcileDueDurableTimers,
  reconcileDurableAgentTurnsOnGatewayStartup,
  reconcileDurableChatSendsOnGatewayStartup,
  reconcilePendingDurableSignals,
  reconcileStaleDurableAgentTurns,
  reconcileStaleDurableChatSends,
  resolveDurableStaleRuntimeRunAfterMs,
  startDurableRecoveryWorker,
} from "./recovery.js";
import {
  DURABLE_AGENT_TURN_OPERATION_KIND,
  DURABLE_CHAT_SEND_OPERATION_KIND,
} from "./runtime-ids.js";
import { openDurableRuntimeSqliteStore } from "./sqlite-store.js";

describe("durable runtime recovery", () => {
  afterEach(() => {
    resetConfigRuntimeState();
  });

  it("derives lost-heartbeat detection from the worker lease with a safe floor", () => {
    setRuntimeConfigSnapshot({
      durable: { mode: "authority", worker: { claimTtlMs: 300_000 } },
    });
    expect(resolveDurableStaleRuntimeRunAfterMs()).toBe(600_000);
    setRuntimeConfigSnapshot({
      durable: { mode: "authority", worker: { claimTtlMs: 1000 } },
    });
    expect(resolveDurableStaleRuntimeRunAfterMs()).toBe(120_000);
  });

  it("does not start the recovery worker unless authority is explicit", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-recovery-worker-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    setRuntimeConfigSnapshot({ durable: { mode: "observe" } });
    vi.useFakeTimers();
    try {
      const stop = startDurableRecoveryWorker({ processInstanceId: "process-observation", env });
      vi.advanceTimersByTime(120_000);
      stop();
      expect(fs.existsSync(resolveDurableRuntimeSqlitePath(env))).toBe(false);
    } finally {
      vi.useRealTimers();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("uses the configured production poll interval for due recovery work", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-recovery-worker-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    setRuntimeConfigSnapshot({
      durable: {
        mode: "authority",
        worker: { pollIntervalMs: 25, claimTtlMs: 120 },
      },
    });
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const store = openDurableRuntimeSqliteStore({ path: resolveDurableRuntimeSqlitePath(env) });
    const run = store.createRun({
      operationKind: "test.recovery-poll",
      rootOperationReason: "recovery_poll_test",
      status: "waiting_timer",
      recoveryState: "waiting_timer",
      now: 1_000,
    });
    store.createStep({
      runtimeRunId: run.runtimeRunId,
      stepType: "timer",
      status: "waiting",
      recoveryState: "waiting_timer",
      now: 1_000,
    });
    store.createTimer({
      runtimeRunId: run.runtimeRunId,
      timerType: "sleep",
      dueAt: 1_020,
      now: 1_000,
    });
    const stop = startDurableRecoveryWorker({ processInstanceId: "process-authority", env });
    try {
      await vi.advanceTimersByTimeAsync(24);
      expect(store.getRun(run.runtimeRunId)).toMatchObject({ status: "waiting_timer" });

      await vi.advanceTimersByTimeAsync(1);
      expect(store.getRun(run.runtimeRunId)).toMatchObject({
        status: "queued",
        recoveryState: "runnable",
      });
    } finally {
      stop();
      store.close();
      vi.useRealTimers();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("marks only running agent turns lost at gateway startup", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-recovery-"));
    const store = openDurableRuntimeSqliteStore({ path: path.join(dir, "openclaw.sqlite") });
    try {
      const running = store.createRun({
        operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
        sourceOwner: "session_store",
        sourceRef: "agent:test:running",
        idempotencyKey: "run-running",
        status: "running",
        recoveryState: "running",
        metadata: { sessionKey: "agent:test:running" },
        now: 100,
      });
      store.createStep({
        runtimeRunId: running.runtimeRunId,
        stepId: "agent_invocation",
        stepType: "agent",
        status: "running",
        recoveryState: "running",
        now: 100,
      });
      const waiting = store.createRun({
        operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
        rootOperationReason: "recovery_test_waiting_turn",
        status: "waiting_signal",
        recoveryState: "waiting_signal",
        now: 100,
      });

      expect(
        reconcileDurableAgentTurnsOnGatewayStartup({
          store,
          processInstanceId: "process-1",
          now: 200,
        }),
      ).toEqual({ scanned: 2, markedLost: 1 });
      expect(store.getRun(running.runtimeRunId)).toMatchObject({
        status: "lost",
        recoveryState: "lost",
        completedAt: 200,
      });
      expect(store.listSteps(running.runtimeRunId)).toEqual([
        expect.objectContaining({ status: "lost", recoveryState: "lost" }),
      ]);
      expect(store.getRun(waiting.runtimeRunId)).toMatchObject({ status: "waiting_signal" });
      expect(store.listWakeObligations()).toEqual([
        expect.objectContaining({ reason: "restart_interrupted", status: "pending" }),
      ]);
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks accepted chat intake lost after restart without replaying it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-recovery-"));
    const store = openDurableRuntimeSqliteStore({ path: path.join(dir, "openclaw.sqlite") });
    try {
      const chat = store.createRun({
        operationKind: DURABLE_CHAT_SEND_OPERATION_KIND,
        sourceOwner: "session_store",
        sourceRef: "agent:test:main",
        status: "received",
        recoveryState: "runnable",
        now: 100,
      });
      expect(
        reconcileDurableChatSendsOnGatewayStartup({
          store,
          processInstanceId: "process-2",
          now: 200,
        }),
      ).toEqual({ scanned: 1, markedLost: 1 });
      expect(store.getRun(chat.runtimeRunId)).toMatchObject({ status: "lost" });
      expect(store.getTimeline(chat.runtimeRunId).at(-1)).toMatchObject({
        eventType: "chat.send.lost",
      });
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks only stale active front-door runs lost", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-recovery-"));
    const store = openDurableRuntimeSqliteStore({ path: path.join(dir, "openclaw.sqlite") });
    try {
      const staleAgent = store.createRun({
        operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
        rootOperationReason: "recovery_test_stale_agent",
        status: "running",
        recoveryState: "running",
        now: 100,
      });
      const freshAgent = store.createRun({
        operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
        rootOperationReason: "recovery_test_fresh_agent",
        status: "running",
        recoveryState: "running",
        now: 1_900,
      });
      const staleChat = store.createRun({
        operationKind: DURABLE_CHAT_SEND_OPERATION_KIND,
        rootOperationReason: "recovery_test_stale_chat",
        status: "received",
        recoveryState: "runnable",
        now: 100,
      });
      expect(
        reconcileStaleDurableAgentTurns({
          store,
          processInstanceId: "process-3",
          now: 2_000,
          staleAfterMs: 1_000,
        }),
      ).toMatchObject({ scanned: 2, markedLost: 1 });
      expect(
        reconcileStaleDurableChatSends({
          store,
          processInstanceId: "process-3",
          now: 2_000,
          staleAfterMs: 1_000,
        }),
      ).toMatchObject({ scanned: 1, markedLost: 1 });
      expect(store.getRun(staleAgent.runtimeRunId)?.status).toBe("lost");
      expect(store.getRun(freshAgent.runtimeRunId)?.status).toBe("running");
      expect(store.getRun(staleChat.runtimeRunId)?.status).toBe("lost");
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("queues retry work only when its durable timer is due", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-recovery-"));
    const store = openDurableRuntimeSqliteStore({ path: path.join(dir, "openclaw.sqlite") });
    try {
      const run = store.createRun({
        operationKind: "test.retry",
        rootOperationReason: "recovery_test_retry",
        status: "retry_scheduled",
        recoveryState: "retry_scheduled",
        now: 100,
      });
      store.createStep({
        runtimeRunId: run.runtimeRunId,
        stepId: "retry",
        stepType: "tool",
        status: "retry_scheduled",
        recoveryState: "retry_scheduled",
        now: 100,
      });
      const timer = store.createTimer({
        runtimeRunId: run.runtimeRunId,
        stepId: "retry",
        timerType: "retry",
        dueAt: 200,
        now: 100,
      });
      expect(
        reconcileDueDurableTimers({ store, processInstanceId: "process-4", now: 200 }),
      ).toMatchObject({ firedTimers: 1, queuedRuns: 1 });
      expect(store.getRun(run.runtimeRunId)).toMatchObject({
        status: "queued",
        recoveryState: "runnable",
      });
      expect(store.listTimers(run.runtimeRunId)).toEqual([
        expect.objectContaining({ timerId: timer.timerId, status: "fired" }),
      ]);
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("consumes resume signals once and requeues their waiting run", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-recovery-"));
    const store = openDurableRuntimeSqliteStore({ path: path.join(dir, "openclaw.sqlite") });
    try {
      const run = store.createRun({
        operationKind: "test.signal",
        rootOperationReason: "recovery_test_signal",
        status: "waiting_signal",
        recoveryState: "waiting_signal",
        now: 100,
      });
      store.createStep({
        runtimeRunId: run.runtimeRunId,
        stepId: "wait",
        stepType: "signal",
        status: "waiting",
        recoveryState: "waiting_signal",
        now: 100,
      });
      const signal = store.createSignal({
        runtimeRunId: run.runtimeRunId,
        signalType: "resume",
        now: 150,
      });
      expect(
        reconcilePendingDurableSignals({ store, processInstanceId: "process-5", now: 200 }),
      ).toMatchObject({ consumedSignals: 1, queuedRuns: 1 });
      expect(store.getRun(run.runtimeRunId)).toMatchObject({
        status: "queued",
        recoveryState: "runnable",
      });
      expect(store.listSignals(run.runtimeRunId)).toEqual([
        expect.objectContaining({ signalId: signal.signalId, consumedAt: 200 }),
      ]);
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
