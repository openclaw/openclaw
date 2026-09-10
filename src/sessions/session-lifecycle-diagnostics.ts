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
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { StoreWriterQueue, StoreWriterTiming } from "../shared/store-writer-queue.js";

type QueueKind = "lifecycle" | "mutation";
type Operation = QueueKind | "compaction";
type Phase =
  | "admission"
  | "activation"
  | "prepare"
  | "run-admission"
  | "run"
  | "finalize"
  | "release";
type Holder = { operation: LifecycleDiagnosticOperation; acquiredAt: number };
const SLOW_MS = 1_000;
const MAX_HOLDERS = 128;
const MAX_WATCHERS = 32;
const log = createSubsystemLogger("sessions/lifecycle");

function state() {
  return resolveGlobalSingleton(Symbol.for("openclaw.sessionLifecycleDiagnostics"), () => ({
    salt: randomBytes(16),
    epoch: randomBytes(8).toString("hex"),
    sequence: 0,
    watchers: 0,
    omitted: 0,
    holders: new WeakMap<StoreWriterQueue, Holder>(),
    trackedHolders: 0,
    budget: createFixedWindowBudget({
      maxRequests: 60,
      windowMs: 60_000,
      now: () => performance.now(),
    }),
  }));
}

function emit(
  message: string,
  operation: LifecycleDiagnosticOperation,
  fields: () => Record<string, unknown>,
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
        ...fields(),
      });
    });
    current.omitted = 0;
  } catch {
    // Diagnostic hashing or logging cannot replace the operation's result.
    current.omitted++;
  }
}

export type LifecycleDiagnosticOperation = {
  readonly id: number;
  readonly operation: Operation;
  readonly rootQueue: QueueKind;
  readonly signal?: AbortSignal;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly parentSpanId?: string;
  readonly traceFlags?: string;
  phase: Phase;
  mark: (phase: Phase) => void;
  finish: (finishedAt?: number) => void;
  queueWaitMs: Record<QueueKind, number>;
};

export function createLifecycleDiagnosticOperation(
  operation: Operation,
  signal?: AbortSignal,
): LifecycleDiagnosticOperation | undefined {
  try {
    if (!areDiagnosticsEnabledForProcess()) {
      return undefined;
    }
    const current = state();
    const trace = getActiveDiagnosticTraceContext();
    const traceId = trace?.traceId;
    const spanId = trace?.spanId;
    const parentSpanId = trace?.parentSpanId;
    const traceFlags = trace?.traceFlags;
    const startedAt = performance.now();
    let phaseStartedAt = startedAt;
    const phaseDurationsMs = { prepare: 0, run: 0, finalize: 0 };
    const result: LifecycleDiagnosticOperation = {
      id: ++current.sequence,
      operation,
      rootQueue: operation === "lifecycle" ? "lifecycle" : "mutation",
      ...(signal ? { signal } : {}),
      ...(isValidDiagnosticTraceId(traceId) ? { traceId } : {}),
      ...(isValidDiagnosticSpanId(spanId) ? { spanId } : {}),
      ...(isValidDiagnosticSpanId(parentSpanId) ? { parentSpanId } : {}),
      ...(isValidDiagnosticTraceFlags(traceFlags) ? { traceFlags } : {}),
      phase: "admission",
      queueWaitMs: { lifecycle: 0, mutation: 0 },
      mark(phase) {
        const now = performance.now();
        if (result.phase === "prepare" || result.phase === "run" || result.phase === "finalize") {
          phaseDurationsMs[result.phase] += now - phaseStartedAt;
        }
        result.phase = phase;
        phaseStartedAt = now;
      },
      finish(finishedAt) {
        result.mark("release");
        const elapsedMs = performance.now() - startedAt;
        if (elapsedMs < SLOW_MS) {
          return;
        }
        emit("slow session lifecycle operation", result, () => ({
          operationId: result.id,
          operation: result.operation,
          operationTraceId: result.traceId,
          operationSpanId: result.spanId,
          elapsedMs: Math.round(elapsedMs),
          ...(finishedAt !== undefined
            ? { completionDelayMs: Math.round(performance.now() - finishedAt) }
            : {}),
          mutationQueueWaitMs: Math.round(result.queueWaitMs.mutation),
          lifecycleQueueWaitMs: Math.round(result.queueWaitMs.lifecycle),
          phaseDurationsMs: Object.fromEntries(
            Object.entries(phaseDurationsMs).map(([phase, value]) => [phase, Math.round(value)]),
          ),
          signalAborted: signal?.aborted ?? false,
        }));
      },
    };
    return result;
  } catch {
    return undefined;
  }
}

export function beginLifecycleDiagnosticQueue(
  operation: LifecycleDiagnosticOperation,
  kind: QueueKind,
  queues: Map<string, StoreWriterQueue>,
  identity: string,
) {
  const current = state();
  const enqueuedAt = performance.now();
  const timing: StoreWriterTiming = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  const stopWatching = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
      current.watchers--;
    }
    removeAbortListener?.();
    removeAbortListener = undefined;
  };
  return {
    timing,
    watch() {
      // Idle and reentrant callbacks start synchronously before watch is called.
      if (timing.startedAt !== undefined || operation.signal?.aborted) {
        return;
      }
      if (current.watchers >= MAX_WATCHERS) {
        current.omitted++;
        return;
      }
      current.watchers++;
      timer = setTimeout(() => {
        stopWatching();
        if (timing.startedAt !== undefined || operation.signal?.aborted) {
          return;
        }
        const now = performance.now();
        const queue = queues.get(identity);
        const holder = queue && current.holders.get(queue);
        // This is the holder now, never a predecessor remembered at enqueue.
        emit("session lifecycle queue waiting", operation, () => ({
          operationId: operation.id,
          operation: operation.operation,
          operationTraceId: operation.traceId,
          operationSpanId: operation.spanId,
          queueKind: kind,
          identityHash: createHash("sha256").update(current.salt).update(identity).digest("hex"),
          waitMs: Math.round(now - enqueuedAt),
          holderObserved: Boolean(holder),
          ...(holder
            ? {
                holderOperationId: holder.operation.id,
                holderOperation: holder.operation.operation,
                holderPhase: holder.operation.phase,
                holderTraceId: holder.operation.traceId,
                holderSpanId: holder.operation.spanId,
                holderElapsedMs: Math.round(now - holder.acquiredAt),
                holderSignalAborted: holder.operation.signal?.aborted ?? false,
              }
            : {}),
        }));
      }, SLOW_MS);
      timer.unref();
      const onAbort = () => stopWatching();
      operation.signal?.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => operation.signal?.removeEventListener("abort", onAbort);
    },
    enter() {
      stopWatching();
      const queue = queues.get(identity);
      if (!queue) {
        current.omitted++;
        return undefined;
      }
      // Only the queue owner can distinguish real acquisition from reentry into an unobserved holder.
      if (timing.reentrant !== false || current.holders.has(queue)) {
        return undefined;
      }
      if (current.trackedHolders >= MAX_HOLDERS) {
        current.omitted++;
        return undefined;
      }
      const holder: Holder = { operation, acquiredAt: performance.now() };
      current.holders.set(queue, holder);
      current.trackedHolders++;
      return () => {
        if (current.holders.get(queue) === holder) {
          current.holders.delete(queue);
          current.trackedHolders--;
        }
      };
    },
    finish() {
      stopWatching();
      if (timing.startedAt !== undefined) {
        operation.queueWaitMs[kind] += timing.startedAt - enqueuedAt;
      }
    },
  };
}
