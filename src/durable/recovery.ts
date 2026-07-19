import { createSubsystemLogger } from "../logging/subsystem.js";
// Recovery reconciliation for durable runtime runs.
import {
  isDurableWorkerEnabled,
  resolveDurableWorkerClaimTtlMs,
  resolveDurableWorkerPollIntervalMs,
} from "./config.js";
import { recordDurableRuntimeHealthFailure, recordDurableRuntimeHealthSuccess } from "./health.js";
import { getDurableRuntimeRegistry, type DurableRuntimeRegistry } from "./registry.js";
import {
  DURABLE_AGENT_TURN_OPERATION_KIND,
  DURABLE_CHAT_SEND_OPERATION_KIND,
} from "./runtime-ids.js";
import { recoverDurableSessionAttentionDeliveries } from "./session-owner-adapter.js";
import { openDurableRuntimeStore } from "./store-factory.js";
import type { DurableRuntimeRun, DurableRuntimeStep, DurableRuntimeStore } from "./types.js";
import { runDurableWakeDispatcherOnce } from "./wake-dispatcher.js";
import { runRegisteredDurableWorkersOnce } from "./worker.js";

const log = createSubsystemLogger("durable/recovery");

const MIN_STALE_RUNTIME_RUN_AFTER_MS = 2 * 60_000;
const DEFAULT_STALE_SCAN_INTERVAL_MS = 60_000;
const RECOVERY_DIAGNOSTIC_METADATA_KEY = "recoveryDiagnostic";

function ensureCoreDurableRuntimeDefinitions(registry: DurableRuntimeRegistry): void {
  if (!registry.getRuntime(DURABLE_AGENT_TURN_OPERATION_KIND, "1")) {
    registry.registerRuntime({
      operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
      version: "1",
      stepTypes: ["agent"],
    });
  }
  if (!registry.getRuntime(DURABLE_CHAT_SEND_OPERATION_KIND, "1")) {
    registry.registerRuntime({
      operationKind: DURABLE_CHAT_SEND_OPERATION_KIND,
      version: "1",
      stepTypes: ["checkpoint"],
    });
  }
}

export function resolveDurableStaleRuntimeRunAfterMs(): number {
  return Math.max(MIN_STALE_RUNTIME_RUN_AFTER_MS, resolveDurableWorkerClaimTtlMs() * 2);
}

export type DurableRecoveryResult = {
  scanned: number;
  markedLost: number;
  firedTimers?: number;
  consumedSignals?: number;
  queuedRuns?: number;
};

function shouldMarkAgentTurnLost(run: DurableRuntimeRun): boolean {
  if (run.operationKind !== DURABLE_AGENT_TURN_OPERATION_KIND) {
    return false;
  }
  return run.status === "received" || run.status === "running";
}

function shouldMarkChatSendLost(run: DurableRuntimeRun): boolean {
  if (run.operationKind !== DURABLE_CHAT_SEND_OPERATION_KIND) {
    return false;
  }
  return run.status === "received" || run.status === "queued" || run.status === "running";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function correlationIdForRun(run: DurableRuntimeRun): string | undefined {
  return firstString(run.metadata?.sessionKey, run.sourceRef);
}

function runtimeSubject(run: DurableRuntimeRun): string {
  if (run.operationKind === DURABLE_AGENT_TURN_OPERATION_KIND) {
    return "Agent turn";
  }
  if (run.operationKind === DURABLE_CHAT_SEND_OPERATION_KIND) {
    return "Chat send";
  }
  return "Runtime run";
}

function lostNextAction(run: DurableRuntimeRun): string {
  const input = lostInputRecoveryHint(run);
  const canReplay = input?.canReplay === true;
  if (run.operationKind === DURABLE_AGENT_TURN_OPERATION_KIND) {
    return canReplay
      ? "inspect_timeline_then_requeue_agent_step"
      : "inspect_timeline_then_retry_or_resume";
  }
  if (run.operationKind === DURABLE_CHAT_SEND_OPERATION_KIND) {
    return canReplay
      ? "inspect_timeline_then_requeue_chat_send"
      : "inspect_timeline_then_retry_request";
  }
  return "inspect_timeline_then_apply_policy";
}

function safeRecoveryActions(run: DurableRuntimeRun): string[] {
  const input = lostInputRecoveryHint(run);
  const actions = ["inspect_timeline"];
  if (input?.canReplay) {
    actions.push("requeue_from_durable_input");
  }
  actions.push("retry_request");
  return actions;
}

function lostInputRecoveryHint(run: DurableRuntimeRun):
  | {
      inputRef?: string;
      inputAvailability?: string;
      canReplay?: boolean;
      reason?: string;
      messageLength?: number;
      messageHash?: string;
    }
  | undefined {
  const metadata = isRecord(run.metadata) ? run.metadata : {};
  const envelope = isRecord(metadata.intakeEnvelope) ? metadata.intakeEnvelope : undefined;
  const replay = isRecord(envelope?.replay) ? envelope.replay : undefined;
  const message = isRecord(envelope?.message) ? envelope.message : undefined;
  if (!run.inputRef && !envelope) {
    return undefined;
  }
  return {
    ...(run.inputRef ? { inputRef: run.inputRef } : {}),
    ...(firstString(replay?.inputAvailability)
      ? { inputAvailability: firstString(replay?.inputAvailability) }
      : {}),
    ...(firstBoolean(replay?.canReplay) !== undefined
      ? { canReplay: firstBoolean(replay?.canReplay) }
      : {}),
    ...(firstString(replay?.reason) ? { reason: firstString(replay?.reason) } : {}),
    ...(typeof message?.length === "number" ? { messageLength: message.length } : {}),
    ...(firstString(message?.hash, metadata.messageHash)
      ? { messageHash: firstString(message?.hash, metadata.messageHash) }
      : {}),
  };
}

function buildLostRecoveryDiagnostic(params: {
  run: DurableRuntimeRun;
  now: number;
  reason: string;
  processInstanceId: string;
}): Record<string, unknown> {
  const subject = runtimeSubject(params.run);
  const input = lostInputRecoveryHint(params.run);
  return {
    state: "lost",
    severity: "error",
    reportable: true,
    retryable: true,
    reason: params.reason,
    message: `${subject} was marked lost during durable recovery; it did not reach a terminal result before the runner disappeared.`,
    nextAction: lostNextAction(params.run),
    processInstanceId: params.processInstanceId,
    detectedAt: params.now,
    previousStatus: params.run.status,
    previousRecoveryState: params.run.recoveryState,
    operationKind: params.run.operationKind,
    runtimeRunId: params.run.runtimeRunId,
    safeRecoveryActions: safeRecoveryActions(params.run),
    ...(input ? { input } : {}),
    ...(params.run.sourceRef ? { sourceRef: params.run.sourceRef } : {}),
  };
}

function mergeRecoveryDiagnosticMetadata(
  metadata: Record<string, unknown> | undefined,
  diagnostic: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...metadata,
    [RECOVERY_DIAGNOSTIC_METADATA_KEY]: diagnostic,
  };
}

function markRunLost(params: {
  store: DurableRuntimeStore;
  run: DurableRuntimeRun;
  now: number;
  reason: string;
  processInstanceId: string;
  eventType: string;
  stepId: string;
  agentInvocationId?: string;
}): boolean {
  const diagnostic = buildLostRecoveryDiagnostic(params);
  params.store.updateRun({
    runtimeRunId: params.run.runtimeRunId,
    status: "lost",
    recoveryState: "lost",
    completedAt: params.now,
    metadata: mergeRecoveryDiagnosticMetadata(params.run.metadata, diagnostic),
    now: params.now,
  });
  for (const step of params.store.listSteps(params.run.runtimeRunId)) {
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
      runtimeRunId: params.run.runtimeRunId,
      stepId: step.stepId,
      status: "lost",
      recoveryState: "lost",
      completedAt: params.now,
      metadata: mergeRecoveryDiagnosticMetadata(step.metadata, diagnostic),
      now: params.now,
    });
  }
  params.store.appendEvent({
    runtimeRunId: params.run.runtimeRunId,
    eventType: params.eventType,
    eventTime: params.now,
    stepId: params.stepId,
    agentInvocationId: params.agentInvocationId,
    idempotencyKey: params.run.idempotencyKey,
    correlationId: correlationIdForRun(params.run),
    payload: {
      reason: params.reason,
      processInstanceId: params.processInstanceId,
      previousStatus: params.run.status,
      previousRecoveryState: params.run.recoveryState,
      recoveryDiagnostic: diagnostic,
    },
  });
  const sourceOwner = params.run.sourceOwner ?? "durable_execution_records";
  const sourceRef = params.run.sourceRef ?? params.run.runtimeRunId;
  const sessionKey = firstString(
    params.run.metadata?.sessionKey,
    params.run.sourceOwner === "session_store" ? params.run.sourceRef : undefined,
  );
  const fact = params.store.recordUncertaintyFact({
    sourceOwner,
    sourceRef,
    kind: "lost_after_dispatch",
    sourceRunId: params.run.runtimeRunId,
    stepId: params.stepId,
    refId: params.processInstanceId,
    dedupeKey: `restart-lost:${params.run.runtimeRunId}:${params.processInstanceId}`,
    facts: diagnostic,
    now: params.now,
  });
  params.store.createWakeObligation({
    sourceOwner,
    sourceRef,
    targetKind: sessionKey ? "agent_session" : "run",
    targetRef: sessionKey ?? params.run.runtimeRunId,
    ownerKind: sessionKey ? "agent_session" : "run",
    ownerRef: sessionKey ?? params.run.runtimeRunId,
    reportRouteRef: sessionKey,
    targetResolutionStatus: "resolved",
    targetResolutionReason: sessionKey
      ? "session resolved from the source execution record"
      : "durable execution record is the inspectable owner",
    reason: "restart_interrupted",
    factsRef: `uncertainty_facts:${fact.factId}`,
    sourceRunId: params.run.runtimeRunId,
    dedupeKey: `restart-wake:${params.run.runtimeRunId}:${sessionKey ?? "run"}`,
    metadata: diagnostic,
    now: params.now,
  });
  return true;
}

function markAgentTurnLost(params: {
  store: DurableRuntimeStore;
  run: DurableRuntimeRun;
  now: number;
  reason: string;
  processInstanceId: string;
}): boolean {
  if (!shouldMarkAgentTurnLost(params.run)) {
    return false;
  }
  return markRunLost({
    ...params,
    eventType: "agent.turn.lost",
    stepId: "recovery",
    agentInvocationId: params.run.idempotencyKey,
  });
}

function markChatSendLost(params: {
  store: DurableRuntimeStore;
  run: DurableRuntimeRun;
  now: number;
  reason: string;
  processInstanceId: string;
}): boolean {
  if (!shouldMarkChatSendLost(params.run)) {
    return false;
  }
  return markRunLost({
    ...params,
    eventType: "chat.send.lost",
    stepId: "intake",
  });
}

export function reconcileDurableAgentTurnsOnGatewayStartup(params: {
  store: DurableRuntimeStore;
  processInstanceId: string;
  now: number;
  limit?: number;
}): DurableRecoveryResult {
  const openRuns = params.store.listOpenRuns({
    operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
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

export function reconcileDurableChatSendsOnGatewayStartup(params: {
  store: DurableRuntimeStore;
  processInstanceId: string;
  now: number;
  limit?: number;
}): DurableRecoveryResult {
  const openRuns = params.store.listOpenRuns({
    operationKind: DURABLE_CHAT_SEND_OPERATION_KIND,
    limit: params.limit ?? 5000,
  });
  let markedLost = 0;
  for (const run of openRuns) {
    if (
      markChatSendLost({
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
  store: DurableRuntimeStore;
  processInstanceId: string;
  now: number;
  staleAfterMs: number;
  limit?: number;
}): DurableRecoveryResult {
  const cutoff = params.now - params.staleAfterMs;
  const openRuns = params.store.listOpenRuns({
    operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
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

export function reconcileStaleDurableChatSends(params: {
  store: DurableRuntimeStore;
  processInstanceId: string;
  now: number;
  staleAfterMs: number;
  limit?: number;
}): DurableRecoveryResult {
  const cutoff = params.now - params.staleAfterMs;
  const openRuns = params.store.listOpenRuns({
    operationKind: DURABLE_CHAT_SEND_OPERATION_KIND,
    limit: params.limit ?? 5000,
  });
  let markedLost = 0;
  for (const run of openRuns) {
    if (run.updatedAt > cutoff) {
      continue;
    }
    if (
      markChatSendLost({
        store: params.store,
        run,
        now: params.now,
        reason: "stale_chat_send_reconciliation",
        processInstanceId: params.processInstanceId,
      })
    ) {
      markedLost += 1;
    }
  }
  return { scanned: openRuns.length, markedLost };
}

function isTerminalRun(run: DurableRuntimeRun): boolean {
  return (
    run.status === "succeeded" ||
    run.status === "failed" ||
    run.status === "cancelled" ||
    run.status === "lost"
  );
}

function isTerminalStep(step: DurableRuntimeStep): boolean {
  return (
    step.status === "succeeded" ||
    step.status === "failed" ||
    step.status === "cancelled" ||
    step.status === "lost" ||
    step.status === "skipped"
  );
}

function markOpenStepsTerminal(params: {
  store: DurableRuntimeStore;
  runtimeRunId: string;
  status: "cancelled" | "lost";
  now: number;
}): void {
  for (const step of params.store.listSteps(params.runtimeRunId)) {
    if (isTerminalStep(step)) {
      continue;
    }
    params.store.updateStep({
      runtimeRunId: params.runtimeRunId,
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
  store: DurableRuntimeStore;
  runtimeRunId: string;
  stepId?: string;
  recoveryState?: "waiting_signal" | "waiting_timer" | "retry_scheduled";
  now: number;
}): number {
  let queued = 0;
  for (const step of params.store.listSteps(params.runtimeRunId)) {
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
      runtimeRunId: params.runtimeRunId,
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
  store: DurableRuntimeStore;
  processInstanceId: string;
  now: number;
  limit?: number;
}): DurableRecoveryResult {
  const timers = params.store.listDueTimers(params.now, { limit: params.limit ?? 500 });
  let firedTimers = 0;
  let queuedRuns = 0;
  for (const timer of timers) {
    const run = params.store.getRun(timer.runtimeRunId);
    params.store.updateTimer({ timerId: timer.timerId, status: "fired", now: params.now });
    firedTimers += 1;
    params.store.appendEvent({
      runtimeRunId: timer.runtimeRunId,
      eventType: "runtime.timer.fired",
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
        runtimeRunId: timer.runtimeRunId,
        stepId: timer.stepId,
        recoveryState: "retry_scheduled",
        now: params.now,
      });
      params.store.updateRun({
        runtimeRunId: timer.runtimeRunId,
        status: "queued",
        recoveryState: "runnable",
        now: params.now,
      });
      queuedRuns += 1;
      params.store.appendEvent({
        runtimeRunId: timer.runtimeRunId,
        eventType: "runtime.retry_due",
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
        runtimeRunId: timer.runtimeRunId,
        stepId: timer.stepId,
        recoveryState: "waiting_timer",
        now: params.now,
      });
      params.store.updateRun({
        runtimeRunId: timer.runtimeRunId,
        status: "queued",
        recoveryState: "runnable",
        now: params.now,
      });
      queuedRuns += 1;
      params.store.appendEvent({
        runtimeRunId: timer.runtimeRunId,
        eventType: "runtime.timer.resume_queued",
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
  store: DurableRuntimeStore;
  processInstanceId: string;
  now: number;
  limit?: number;
}): DurableRecoveryResult {
  const signals = params.store.listPendingSignals({ limit: params.limit ?? 5000 });
  let consumedSignals = 0;
  let queuedRuns = 0;
  for (const signal of signals) {
    const run = params.store.getRun(signal.runtimeRunId);
    if (!run || isTerminalRun(run)) {
      params.store.consumeSignal({ signalId: signal.signalId, now: params.now });
      consumedSignals += 1;
      continue;
    }
    if (signal.signalType === "cancel") {
      params.store.consumeSignal({ signalId: signal.signalId, now: params.now });
      markOpenStepsTerminal({
        store: params.store,
        runtimeRunId: run.runtimeRunId,
        status: "cancelled",
        now: params.now,
      });
      params.store.updateRun({
        runtimeRunId: run.runtimeRunId,
        status: "cancelled",
        recoveryState: "terminal",
        completedAt: params.now,
        now: params.now,
      });
      params.store.appendEvent({
        runtimeRunId: run.runtimeRunId,
        eventType: "runtime.signal.cancelled",
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
        runtimeRunId: run.runtimeRunId,
        stepId: signal.stepId,
        recoveryState: "waiting_signal",
        now: params.now,
      });
      params.store.updateRun({
        runtimeRunId: run.runtimeRunId,
        status: "queued",
        recoveryState: "runnable",
        now: params.now,
      });
      params.store.appendEvent({
        runtimeRunId: run.runtimeRunId,
        eventType: "runtime.signal.resume_queued",
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
  if (!isDurableWorkerEnabled()) {
    return () => {};
  }
  const runtimeRegistry = getDurableRuntimeRegistry();
  ensureCoreDurableRuntimeDefinitions(runtimeRegistry);
  const pollIntervalMs = resolveDurableWorkerPollIntervalMs();
  const claimTtlMs = resolveDurableWorkerClaimTtlMs();
  const staleAfterMs = resolveDurableStaleRuntimeRunAfterMs();
  const staleScanIntervalMs = Math.max(DEFAULT_STALE_SCAN_INTERVAL_MS, pollIntervalMs);
  let running = false;
  let stopped = false;
  let nextStaleScanAt = 0;

  const reconcileOnce = async () => {
    if (running || stopped) {
      return;
    }
    running = true;
    let store: DurableRuntimeStore | null = null;
    try {
      store = openDurableRuntimeStore({ env });
      const now = Date.now();
      const shouldScanStaleRuns = now >= nextStaleScanAt;
      const result = shouldScanStaleRuns
        ? reconcileStaleDurableAgentTurns({
            store,
            processInstanceId: params.processInstanceId,
            now,
            staleAfterMs,
          })
        : { scanned: 0, markedLost: 0 };
      const chatSendResult = shouldScanStaleRuns
        ? reconcileStaleDurableChatSends({
            store,
            processInstanceId: params.processInstanceId,
            now,
            staleAfterMs,
          })
        : { scanned: 0, markedLost: 0 };
      if (shouldScanStaleRuns) {
        nextStaleScanAt = now + staleScanIntervalMs;
      }
      const timerResult = reconcileDueDurableTimers({
        store,
        processInstanceId: params.processInstanceId,
        now,
      });
      const signalResult = reconcilePendingDurableSignals({
        store,
        processInstanceId: params.processInstanceId,
        now,
      });
      const executionResult = await runRegisteredDurableWorkersOnce({
        store,
        registry: runtimeRegistry,
        workerId: params.processInstanceId,
        claimTtlMs,
        maxStepsPerOperation: 32,
        now: () => Date.now(),
      });
      const wakeResult = await runDurableWakeDispatcherOnce({
        store,
        workerId: params.processInstanceId,
        claimTtlMs,
        reconcileOwnerFacts: shouldScanStaleRuns,
      });
      await recoverDurableSessionAttentionDeliveries({ log });
      recordDurableRuntimeHealthSuccess();
      if (
        result.markedLost > 0 ||
        chatSendResult.markedLost > 0 ||
        (timerResult.firedTimers ?? 0) > 0 ||
        (signalResult.consumedSignals ?? 0) > 0 ||
        executionResult.claimsRecovered > 0 ||
        executionResult.claimsBlocked > 0 ||
        executionResult.stepsClaimed > 0 ||
        wakeResult.obligationsCreated > 0 ||
        wakeResult.acknowledged > 0 ||
        wakeResult.handoffAccepted > 0 ||
        wakeResult.suspended > 0 ||
        wakeResult.overdue > 0
      ) {
        log.warn("reconciled durable runtime state", {
          staleScanned: result.scanned,
          markedLost: result.markedLost,
          staleChatSendsScanned: chatSendResult.scanned,
          markedLostChatSends: chatSendResult.markedLost,
          firedTimers: timerResult.firedTimers ?? 0,
          consumedSignals: signalResult.consumedSignals ?? 0,
          queuedRuns: (timerResult.queuedRuns ?? 0) + (signalResult.queuedRuns ?? 0),
          executionClaimsRecovered: executionResult.claimsRecovered,
          executionClaimsBlocked: executionResult.claimsBlocked,
          executionStepsClaimed: executionResult.stepsClaimed,
          ownerFactsScanned: wakeResult.ownerFactsScanned,
          wakeObligationsCreated: wakeResult.obligationsCreated,
          wakeClaims: wakeResult.claimed,
          wakesAcknowledged: wakeResult.acknowledged,
          wakeHandoffsAccepted: wakeResult.handoffAccepted,
          wakesFailed: wakeResult.failed,
          wakesSuspended: wakeResult.suspended,
          wakesOverdue: wakeResult.overdue,
          staleAfterMs,
        });
      }
    } catch (err) {
      recordDurableRuntimeHealthFailure({
        component: "recovery",
        operation: "reconcile_once",
        error: err,
      });
      log.warn(`durable recovery worker failed: ${String(err)}`);
    } finally {
      store?.close();
      running = false;
    }
  };

  const timer = setInterval(() => {
    void reconcileOnce();
  }, pollIntervalMs);
  timer.unref?.();
  void reconcileOnce();
  log.info("started durable recovery worker", {
    pollIntervalMs,
    claimTtlMs,
    staleAfterMs,
    staleScanIntervalMs,
    processInstanceId: params.processInstanceId,
  });

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
