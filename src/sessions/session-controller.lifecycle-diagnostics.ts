import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";
import { areDiagnosticsEnabledForProcess } from "../infra/diagnostic-events.js";
import {
  getActiveDiagnosticTraceContext,
  isValidDiagnosticSpanId,
  isValidDiagnosticTraceFlags,
  isValidDiagnosticTraceId,
  runWithDiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import { createFixedWindowBudget } from "../infra/fixed-window-rate-limit.js";
import { diagnosticLogger } from "../logging/diagnostic-runtime.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const SLOW_MS = 1_000;
const MAX_HOLDERS = 128;
const MAX_WATCHERS = 32;
const log = createSubsystemLogger("sessions/lifecycle");
type QueueKind = "lifecycle" | "mutation";
export type SessionLifecycleDiagnosticLabel =
  | "acp-spawn-cleanup"
  | "archived-delete"
  | "assign-owner"
  | "background-result"
  | "compact"
  | "compaction"
  | "create"
  | "cron-cleanup"
  | "delete"
  | "delete-prepare"
  | "drain"
  | "history-evict"
  | "placement-dispatch"
  | "placement-failed-reclaim"
  | "placement-reclaim"
  | "plugin-create"
  | "read-marker"
  | "recover"
  | "recovery-drain"
  | "recovery-mark"
  | "reset"
  | "sharing"
  | "subagent-kill"
  | "subagent-kill-sweep"
  | "workspace-edit"
  | "worktree-cleanup";
type Phase =
  | "admission"
  | "activation"
  | "prepare"
  | "run-admission"
  | "run"
  | "finalize"
  | "release";

type ControllerPhase =
  | "source-claim"
  | "injection-predecessor"
  | "injection-outcome"
  | "successor-barrier"
  | "followup-barrier"
  | "lifecycle-admission"
  | "recovery-predecessor";
type ControllerPhaseStatus =
  | "waiting"
  | "selected"
  | "settled"
  | "failed"
  | "reserved"
  | "restored";

type PhaseRecord = {
  phase: ControllerPhase;
  status: ControllerPhaseStatus;
  sessionKey: string;
  sessionId?: string;
  sourceId?: string;
  reason?: string;
  pendingInputs?: number;
  injectingInputs?: number;
  withdrawalHolds?: number;
  prioritySourceId?: string;
};

function state() {
  return resolveGlobalSingleton(Symbol.for("openclaw.sessionControllerDiagnostics"), () => ({
    salt: randomBytes(16),
    epoch: randomBytes(8).toString("hex"),
    sequence: 0,
    holders: 0,
    watchers: 0,
    omitted: 0,
    phaseOmitted: 0,
    phaseBudget: createFixedWindowBudget({
      maxRequests: 60,
      windowMs: 60_000,
      now: () => performance.now(),
    }),
    budget: createFixedWindowBudget({
      maxRequests: 60,
      windowMs: 60_000,
      now: () => performance.now(),
    }),
  }));
}

function identityHash(identity: string) {
  return createHash("sha256").update(state().salt).update(identity).digest("hex");
}

function emit(
  message: string,
  fields: () => Record<string, unknown>,
  operation: LifecycleDiagnosticOperation,
) {
  const current = state();
  try {
    if (!areDiagnosticsEnabledForProcess() || !log.isEnabled("warn")) {
      return;
    }
    if (!current.budget.consume().allowed) {
      current.omitted++;
      return;
    }
    const trace = operation.traceId
      ? {
          traceId: operation.traceId,
          spanId: operation.spanId,
          parentSpanId: operation.parentSpanId,
          traceFlags: operation.traceFlags,
        }
      : undefined;
    runWithDiagnosticTraceContext(trace, () => {
      log.warn(message, {
        pid: process.pid,
        threadId,
        isMainThread,
        diagnosticEpoch: current.epoch,
        omittedObservations: current.omitted,
        operationId: operation.id,
        operation: operation.operation,
        mutationKind: operation.mutationKind,
        sessionScopeHash: identityHash(operation.scopeIdentity),
        identityCount: operation.identityCount,
        operationTraceId: operation.traceId,
        operationSpanId: operation.spanId,
        ...fields(),
      });
    });
    current.omitted = 0;
  } catch {
    // Observability must not replace the owner's result or interrupt cleanup.
    current.omitted++;
  }
}

export type LifecycleDiagnosticOperation = {
  readonly id: number;
  readonly operation: "lifecycle" | "mutation" | "compaction";
  readonly mutationKind?: SessionLifecycleDiagnosticLabel;
  readonly scopeIdentity: string;
  readonly identityCount: number;
  readonly signal?: AbortSignal;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly parentSpanId?: string;
  readonly traceFlags?: string;
  readonly observedHolder: boolean;
  readonly acquiredAt: number;
  phase: Phase;
  hold(): void;
  mark(phase: Phase): void;
  wait(kind: QueueKind, currentHolder: () => LifecycleDiagnosticOperation | undefined): () => void;
  finish(finishedAt?: number): void;
};

/** Metadata follows the existing owner; it cannot admit, cancel or release work. */
export function createLifecycleDiagnosticOperation(params: {
  operation: LifecycleDiagnosticOperation["operation"];
  identities: () => readonly string[];
  signal?: AbortSignal;
  mutationKind?: LifecycleDiagnosticOperation["mutationKind"];
}): LifecycleDiagnosticOperation | undefined {
  try {
    if (!areDiagnosticsEnabledForProcess()) {
      return undefined;
    }
    const identities = params.identities();
    const current = state();
    const trace = getActiveDiagnosticTraceContext();
    const startedAt = performance.now();
    let phaseStartedAt = startedAt;
    let acquiredAt = startedAt;
    let observedHolder = false;
    let holderAttempted = false;
    let finished = false;
    const waits = new Set<() => void>();
    const queueWaitMs = { lifecycle: 0, mutation: 0 };
    const phaseDurationsMs = { prepare: 0, run: 0, finalize: 0 };
    const operation: LifecycleDiagnosticOperation = {
      id: ++current.sequence,
      operation: params.operation,
      mutationKind: params.mutationKind,
      scopeIdentity: identities[0] ?? "",
      identityCount: identities.length,
      signal: params.signal,
      ...(isValidDiagnosticTraceId(trace?.traceId) ? { traceId: trace.traceId } : {}),
      ...(isValidDiagnosticSpanId(trace?.spanId) ? { spanId: trace.spanId } : {}),
      ...(isValidDiagnosticSpanId(trace?.parentSpanId) ? { parentSpanId: trace.parentSpanId } : {}),
      ...(isValidDiagnosticTraceFlags(trace?.traceFlags) ? { traceFlags: trace.traceFlags } : {}),
      get observedHolder() {
        return observedHolder && !finished;
      },
      get acquiredAt() {
        return acquiredAt;
      },
      phase: "admission",
      hold() {
        if (holderAttempted || finished) {
          return;
        }
        holderAttempted = true;
        if (current.holders >= MAX_HOLDERS) {
          current.omitted++;
          return;
        }
        observedHolder = true;
        acquiredAt = performance.now();
        current.holders++;
      },
      mark(phase) {
        const now = performance.now();
        if (
          operation.phase === "prepare" ||
          operation.phase === "run" ||
          operation.phase === "finalize"
        ) {
          phaseDurationsMs[operation.phase] += now - phaseStartedAt;
        }
        operation.phase = phase;
        phaseStartedAt = now;
      },
      wait(kind, currentHolder) {
        const enqueuedAt = performance.now();
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const stopWatching = () => {
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
            current.watchers--;
          }
          params.signal?.removeEventListener("abort", stopWatching);
        };
        const stop = () => {
          if (stopped) {
            return;
          }
          stopped = true;
          stopWatching();
          waits.delete(stop);
          queueWaitMs[kind] += performance.now() - enqueuedAt;
        };
        waits.add(stop);
        if (!params.signal?.aborted) {
          if (current.watchers >= MAX_WATCHERS) {
            current.omitted++;
          } else {
            current.watchers++;
            timer = setTimeout(() => {
              stopWatching();
              if (stopped || finished || params.signal?.aborted) {
                return;
              }
              const now = performance.now();
              emit(
                "session lifecycle queue waiting",
                () => {
                  const candidate = currentHolder();
                  const holder = candidate?.observedHolder ? candidate : undefined;
                  return {
                    queueKind: kind,
                    identityHash: identityHash(operation.scopeIdentity),
                    waitMs: Math.round(now - enqueuedAt),
                    holderObserved: Boolean(holder),
                    ...(holder
                      ? {
                          holderOperationId: holder.id,
                          holderOperation: holder.operation,
                          holderMutationKind: holder.mutationKind,
                          holderSessionScopeHash: identityHash(holder.scopeIdentity),
                          holderPhase: holder.phase,
                          holderTraceId: holder.traceId,
                          holderSpanId: holder.spanId,
                          holderElapsedMs: Math.round(now - holder.acquiredAt),
                          holderSignalAborted: holder.signal?.aborted ?? false,
                        }
                      : {}),
                  };
                },
                operation,
              );
            }, SLOW_MS);
            timer.unref();
            params.signal?.addEventListener("abort", stopWatching, { once: true });
          }
        }
        return stop;
      },
      finish(finishedAt) {
        if (finished) {
          return;
        }
        for (const stop of waits) {
          stop();
        }
        operation.mark("release");
        finished = true;
        if (observedHolder) {
          current.holders--;
        }
        const elapsedMs = performance.now() - startedAt;
        if (elapsedMs >= SLOW_MS) {
          emit(
            "slow session lifecycle operation",
            () => ({
              elapsedMs: Math.round(elapsedMs),
              ...(finishedAt === undefined
                ? {}
                : { completionDelayMs: Math.round(performance.now() - finishedAt) }),
              mutationQueueWaitMs: Math.round(queueWaitMs.mutation),
              lifecycleQueueWaitMs: Math.round(queueWaitMs.lifecycle),
              phaseDurationsMs: Object.fromEntries(
                Object.entries(phaseDurationsMs).map(([phase, value]) => [
                  phase,
                  Math.round(value),
                ]),
              ),
              signalAborted: params.signal?.aborted ?? false,
            }),
            operation,
          );
        }
      },
    };
    return operation;
  } catch {
    return undefined;
  }
}

export function createSessionControllerPhaseLogger(
  phase: ControllerPhase,
  identity: { sessionKey: string; sessionId?: string; sourceId?: string },
): (status: ControllerPhaseStatus, reason?: string) => void {
  return (status, reason) => logSessionControllerPhase({ ...identity, phase, status, reason });
}

/** Supplemental phase events have a separate budget so they cannot suppress slow warnings. */
export function logSessionControllerPhase(params: PhaseRecord): void {
  if (!areDiagnosticsEnabledForProcess() || !diagnosticLogger.isEnabled("info")) {
    return;
  }
  try {
    const current = state();
    if (!current.phaseBudget.consume().allowed) {
      current.phaseOmitted++;
      return;
    }
    const { sessionKey, sessionId, sourceId, prioritySourceId, reason, ...fields } = params;
    diagnosticLogger.info("session controller phase", {
      ...fields,
      diagnosticEpoch: current.epoch,
      omittedObservations: current.phaseOmitted,
      sessionScopeHash: identityHash(sessionKey),
      ...(sessionId ? { sessionIdHash: identityHash(sessionId) } : {}),
      ...(sourceId ? { sourceIdHash: identityHash(sourceId) } : {}),
      ...(prioritySourceId ? { prioritySourceIdHash: identityHash(prioritySourceId) } : {}),
      reason: reason?.slice(0, 120),
    });
    current.phaseOmitted = 0;
  } catch {
    // Phase diagnostics cannot change source selection or lifecycle settlement.
  }
}
