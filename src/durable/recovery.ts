import { createSubsystemLogger } from "../logging/subsystem.js";
// Recovery reconciliation for durable workflow runs.
import { isDurableWorkflowsEnabled } from "./config.js";
import { openDurableWorkflowStore } from "./store-factory.js";
import type { DurableWorkflowRun, DurableWorkflowStep, DurableWorkflowStore } from "./types.js";
import { DURABLE_AGENT_TURN_WORKFLOW_ID } from "./workflow-ids.js";

const log = createSubsystemLogger("durable/recovery");

const DEFAULT_RECOVERY_INTERVAL_MS = 60_000;
const DEFAULT_STALE_AGENT_TURN_AFTER_MS = 6 * 60 * 60 * 1000;

export type DurableRecoveryResult = {
  scanned: number;
  markedLost: number;
  firedTimers?: number;
  consumedSignals?: number;
  queuedRuns?: number;
};

function parsePositiveInteger(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function resolveDurableRecoveryIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  return (
    parsePositiveInteger(env.OPENCLAW_DURABLE_RECOVERY_INTERVAL_MS) ?? DEFAULT_RECOVERY_INTERVAL_MS
  );
}

export function resolveDurableStaleAgentTurnAfterMs(env: NodeJS.ProcessEnv = process.env): number {
  return (
    parsePositiveInteger(env.OPENCLAW_DURABLE_STALE_AGENT_TURN_AFTER_MS) ??
    DEFAULT_STALE_AGENT_TURN_AFTER_MS
  );
}

function shouldMarkAgentTurnLost(run: DurableWorkflowRun): boolean {
  if (run.workflowId !== DURABLE_AGENT_TURN_WORKFLOW_ID) {
    return false;
  }
  return run.status === "received" || run.status === "running";
}

function correlationIdForRun(run: DurableWorkflowRun): string | undefined {
  return run.metadata?.sessionKey ? String(run.metadata.sessionKey) : run.sourceRef;
}

function markAgentTurnLost(params: {
  store: DurableWorkflowStore;
  run: DurableWorkflowRun;
  now: number;
  reason: string;
  processInstanceId: string;
}): boolean {
  if (!shouldMarkAgentTurnLost(params.run)) {
    return false;
  }
  params.store.updateRun({
    workflowRunId: params.run.workflowRunId,
    status: "lost",
    recoveryState: "lost",
    completedAt: params.now,
    now: params.now,
  });
  for (const step of params.store.listSteps(params.run.workflowRunId)) {
    if (
      step.status === "succeeded" ||
      step.status === "failed" ||
      step.status === "cancelled" ||
      step.status === "lost" ||
      step.status === "skipped"
    ) {
      continue;
    }
    params.store.updateStep({
      workflowRunId: params.run.workflowRunId,
      stepId: step.stepId,
      status: "lost",
      recoveryState: "lost",
      completedAt: params.now,
      now: params.now,
    });
  }
  params.store.appendEvent({
    workflowRunId: params.run.workflowRunId,
    eventType: "agent.turn.lost",
    eventTime: params.now,
    stepId: "recovery",
    agentInvocationId: params.run.idempotencyKey,
    idempotencyKey: params.run.idempotencyKey,
    correlationId: correlationIdForRun(params.run),
    payload: {
      reason: params.reason,
      processInstanceId: params.processInstanceId,
      previousStatus: params.run.status,
      previousRecoveryState: params.run.recoveryState,
    },
  });
  return true;
}

export function reconcileDurableAgentTurnsOnGatewayStartup(params: {
  store: DurableWorkflowStore;
  processInstanceId: string;
  now: number;
  limit?: number;
}): DurableRecoveryResult {
  const openRuns = params.store.listOpenRuns({
    workflowId: DURABLE_AGENT_TURN_WORKFLOW_ID,
    limit: params.limit ?? 5000,
  });
  let markedLost = 0;
  for (const run of openRuns) {
    if (
      markAgentTurnLost({
        store: params.store,
        run,
        now: params.now,
        reason: "gateway_startup_reconciliation",
        processInstanceId: params.processInstanceId,
      })
    ) {
      markedLost += 1;
    }
  }
  return { scanned: openRuns.length, markedLost };
}

export function reconcileStaleDurableAgentTurns(params: {
  store: DurableWorkflowStore;
  processInstanceId: string;
  now: number;
  staleAfterMs: number;
  limit?: number;
}): DurableRecoveryResult {
  const cutoff = params.now - params.staleAfterMs;
  const openRuns = params.store.listOpenRuns({
    workflowId: DURABLE_AGENT_TURN_WORKFLOW_ID,
    limit: params.limit ?? 5000,
  });
  let markedLost = 0;
  for (const run of openRuns) {
    if (run.updatedAt > cutoff) {
      continue;
    }
    if (
      markAgentTurnLost({
        store: params.store,
        run,
        now: params.now,
        reason: "stale_agent_turn_reconciliation",
        processInstanceId: params.processInstanceId,
      })
    ) {
      markedLost += 1;
    }
  }
  return { scanned: openRuns.length, markedLost };
}

function isTerminalRun(run: DurableWorkflowRun): boolean {
  return (
    run.status === "succeeded" ||
    run.status === "failed" ||
    run.status === "cancelled" ||
    run.status === "lost"
  );
}

function isTerminalStep(step: DurableWorkflowStep): boolean {
  return (
    step.status === "succeeded" ||
    step.status === "failed" ||
    step.status === "cancelled" ||
    step.status === "lost" ||
    step.status === "skipped"
  );
}

function markOpenStepsTerminal(params: {
  store: DurableWorkflowStore;
  workflowRunId: string;
  status: "cancelled" | "lost";
  now: number;
}): void {
  for (const step of params.store.listSteps(params.workflowRunId)) {
    if (isTerminalStep(step)) {
      continue;
    }
    params.store.updateStep({
      workflowRunId: params.workflowRunId,
      stepId: step.stepId,
      status: params.status,
      recoveryState: params.status === "lost" ? "lost" : "terminal",
      claimedBy: null,
      claimExpiresAt: null,
      heartbeatAt: null,
      completedAt: params.now,
      now: params.now,
    });
  }
}

function queueStepForRecovery(params: {
  store: DurableWorkflowStore;
  workflowRunId: string;
  stepId?: string;
  recoveryState?: "waiting_signal" | "waiting_timer" | "retry_scheduled";
  now: number;
}): number {
  let queued = 0;
  for (const step of params.store.listSteps(params.workflowRunId)) {
    if (isTerminalStep(step)) {
      continue;
    }
    if (params.stepId && step.stepId !== params.stepId) {
      continue;
    }
    if (!params.stepId && params.recoveryState && step.recoveryState !== params.recoveryState) {
      continue;
    }
    params.store.updateStep({
      workflowRunId: params.workflowRunId,
      stepId: step.stepId,
      status: "queued",
      recoveryState: "runnable",
      claimedBy: null,
      claimExpiresAt: null,
      heartbeatAt: null,
      now: params.now,
    });
    queued += 1;
  }
  return queued;
}

export function reconcileDueDurableTimers(params: {
  store: DurableWorkflowStore;
  processInstanceId: string;
  now: number;
  limit?: number;
}): DurableRecoveryResult {
  const timers = params.store.listDueTimers(params.now, { limit: params.limit ?? 500 });
  let firedTimers = 0;
  let queuedRuns = 0;
  for (const timer of timers) {
    const run = params.store.getRun(timer.workflowRunId);
    params.store.updateTimer({ timerId: timer.timerId, status: "fired", now: params.now });
    firedTimers += 1;
    params.store.appendEvent({
      workflowRunId: timer.workflowRunId,
      eventType: "workflow.timer.fired",
      eventTime: params.now,
      stepId: timer.stepId,
      payload: {
        timerId: timer.timerId,
        timerType: timer.timerType,
        processInstanceId: params.processInstanceId,
      },
    });
    if (!run || isTerminalRun(run)) {
      continue;
    }
    if (timer.timerType === "retry") {
      queueStepForRecovery({
        store: params.store,
        workflowRunId: timer.workflowRunId,
        stepId: timer.stepId,
        recoveryState: "retry_scheduled",
        now: params.now,
      });
      params.store.updateRun({
        workflowRunId: timer.workflowRunId,
        status: "queued",
        recoveryState: "runnable",
        now: params.now,
      });
      queuedRuns += 1;
      params.store.appendEvent({
        workflowRunId: timer.workflowRunId,
        eventType: "workflow.retry_due",
        eventTime: params.now,
        stepId: timer.stepId,
        payload: {
          timerId: timer.timerId,
          processInstanceId: params.processInstanceId,
        },
      });
      continue;
    }
    if (run.status === "waiting_timer" || run.recoveryState === "waiting_timer") {
      queueStepForRecovery({
        store: params.store,
        workflowRunId: timer.workflowRunId,
        stepId: timer.stepId,
        recoveryState: "waiting_timer",
        now: params.now,
      });
      params.store.updateRun({
        workflowRunId: timer.workflowRunId,
        status: "queued",
        recoveryState: "runnable",
        now: params.now,
      });
      queuedRuns += 1;
      params.store.appendEvent({
        workflowRunId: timer.workflowRunId,
        eventType: "workflow.timer.resume_queued",
        eventTime: params.now,
        stepId: timer.stepId,
        payload: {
          timerId: timer.timerId,
          timerType: timer.timerType,
          processInstanceId: params.processInstanceId,
        },
      });
    }
  }
  return { scanned: timers.length, markedLost: 0, firedTimers, queuedRuns };
}

export function reconcilePendingDurableSignals(params: {
  store: DurableWorkflowStore;
  processInstanceId: string;
  now: number;
  limit?: number;
}): DurableRecoveryResult {
  const signals = params.store.listPendingSignals({ limit: params.limit ?? 5000 });
  let consumedSignals = 0;
  let queuedRuns = 0;
  for (const signal of signals) {
    const run = params.store.getRun(signal.workflowRunId);
    if (!run || isTerminalRun(run)) {
      params.store.consumeSignal({ signalId: signal.signalId, now: params.now });
      consumedSignals += 1;
      continue;
    }
    if (signal.signalType === "cancel") {
      params.store.consumeSignal({ signalId: signal.signalId, now: params.now });
      markOpenStepsTerminal({
        store: params.store,
        workflowRunId: run.workflowRunId,
        status: "cancelled",
        now: params.now,
      });
      params.store.updateRun({
        workflowRunId: run.workflowRunId,
        status: "cancelled",
        recoveryState: "terminal",
        completedAt: params.now,
        now: params.now,
      });
      params.store.appendEvent({
        workflowRunId: run.workflowRunId,
        eventType: "workflow.signal.cancelled",
        eventTime: params.now,
        correlationId: signal.correlationId,
        payload: {
          signalId: signal.signalId,
          processInstanceId: params.processInstanceId,
        },
      });
      consumedSignals += 1;
      continue;
    }
    if (
      signal.signalType === "resume" ||
      run.recoveryState === "waiting_signal" ||
      run.status === "waiting_signal"
    ) {
      params.store.consumeSignal({ signalId: signal.signalId, now: params.now });
      queueStepForRecovery({
        store: params.store,
        workflowRunId: run.workflowRunId,
        stepId: signal.stepId,
        recoveryState: "waiting_signal",
        now: params.now,
      });
      params.store.updateRun({
        workflowRunId: run.workflowRunId,
        status: "queued",
        recoveryState: "runnable",
        now: params.now,
      });
      params.store.appendEvent({
        workflowRunId: run.workflowRunId,
        eventType: "workflow.signal.resume_queued",
        eventTime: params.now,
        correlationId: signal.correlationId,
        payload: {
          signalId: signal.signalId,
          signalType: signal.signalType,
          processInstanceId: params.processInstanceId,
        },
      });
      consumedSignals += 1;
      queuedRuns += 1;
    }
  }
  return { scanned: signals.length, markedLost: 0, consumedSignals, queuedRuns };
}

export function startDurableRecoveryWorker(params: {
  processInstanceId: string;
  env?: NodeJS.ProcessEnv;
}): () => void {
  const env = params.env ?? process.env;
  if (!isDurableWorkflowsEnabled(env)) {
    return () => {};
  }
  const intervalMs = resolveDurableRecoveryIntervalMs(env);
  const staleAfterMs = resolveDurableStaleAgentTurnAfterMs(env);
  let running = false;
  let stopped = false;

  const reconcileOnce = () => {
    if (running || stopped) {
      return;
    }
    running = true;
    let store: DurableWorkflowStore | null = null;
    try {
      store = openDurableWorkflowStore({ env });
      const result = reconcileStaleDurableAgentTurns({
        store,
        processInstanceId: params.processInstanceId,
        now: Date.now(),
        staleAfterMs,
      });
      const timerResult = reconcileDueDurableTimers({
        store,
        processInstanceId: params.processInstanceId,
        now: Date.now(),
      });
      const signalResult = reconcilePendingDurableSignals({
        store,
        processInstanceId: params.processInstanceId,
        now: Date.now(),
      });
      if (
        result.markedLost > 0 ||
        (timerResult.firedTimers ?? 0) > 0 ||
        (signalResult.consumedSignals ?? 0) > 0
      ) {
        log.warn("reconciled durable workflow state", {
          staleScanned: result.scanned,
          markedLost: result.markedLost,
          firedTimers: timerResult.firedTimers ?? 0,
          consumedSignals: signalResult.consumedSignals ?? 0,
          queuedRuns: (timerResult.queuedRuns ?? 0) + (signalResult.queuedRuns ?? 0),
          staleAfterMs,
        });
      }
    } catch (err) {
      log.warn(`durable recovery worker failed: ${String(err)}`);
    } finally {
      store?.close();
      running = false;
    }
  };

  const timer = setInterval(reconcileOnce, intervalMs);
  timer.unref?.();
  log.info("started durable recovery worker", {
    intervalMs,
    staleAfterMs,
    processInstanceId: params.processInstanceId,
  });

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
