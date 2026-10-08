import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { captureDirectEmbeddedMessageInjectionTarget } from "../../agents/embedded-agent-runner/message-injection-target.js";
import { chatRunBelongsToAgent } from "../../gateway/chat-run-owner.js";
import type { GatewayContextResolver } from "../../gateway/server-methods/types.js";
import {
  isAgentEventLifecycleGenerationCurrent,
  registerAgentEventLifecycleRotationHandler,
} from "../../infra/agent-events.js";
import { markDiagnosticRunProgress } from "../../logging/diagnostic-run-activity.js";
import { hasGatewayContextOwner } from "../../plugins/runtime/gateway-request-scope.js";
import { agentSessionKeysMatchByRequestKey } from "../../routing/session-key.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { settlesWithin } from "../../shared/settle-within.js";
import * as replyRunSettle from "./reply-run-finalization-lease.js";
import {
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  replyMessageInjectionTargetOwner,
  replyRunInterruptTargetOperation,
  type ReplyOperation,
  type ReplyRunInterruptTarget,
  type ReplyRunRegistry,
} from "./reply-run-registry.contracts.js";
import { resolveReplyMessageInjectionRejection } from "./reply-run-registry.message-injection.js";
import { createReplyOperation } from "./reply-run-registry.operation.js";
import {
  clearReplyRunState,
  evictReplyOperationByOperation,
  expireStaleReplyOperation,
  forceClearReplyOperation,
  getAttachedBackend,
  hasReplyOperationExecutionStarted,
  isReplyOperationPreBackendPhase,
  isReplyRunCompacting,
  isReplyRunEvidenceStale,
  mergeReplyRunAdmissionSource,
  replyRunState,
  resolveReplyRunForCurrentSessionId,
  resolveReplyRunWaitKey,
  type ReplyRunAdmissionBarrier,
  type ReplyRunAdmissionSource,
  type ReplyRunWaiter,
} from "./reply-run-registry.state.js";

type ReplyOperationStaleReason = replyRunSettle.ReplyOperationStaleReason;

type ReplyRunAdmissionSettlement = {
  settled: boolean;
  sources?: ReplyRunAdmissionSource[];
};

type ReplyOperationSessionTarget = {
  sessionKeys: readonly string[];
  sessionId?: string;
  agentId: string;
  defaultAgentId?: string;
};

export function isReplyOperationForSession(
  params: ReplyOperationSessionTarget,
  operation: ReplyOperation | undefined,
): operation is ReplyOperation {
  return (
    operation !== undefined &&
    (!params.sessionId || operation.sessionId === params.sessionId) &&
    params.sessionKeys.some((key) => agentSessionKeysMatchByRequestKey(operation.key, key)) &&
    chatRunBelongsToAgent(
      {
        agentId: operation.agentId,
        sessionKey: operation.key,
        defaultAgentId: params.defaultAgentId,
      },
      params.agentId,
    )
  );
}

export function resolveReplyOperationsForSession(params: ReplyOperationSessionTarget) {
  const candidates = [
    ...params.sessionKeys.map((key) => replyRunRegistry.get(key)),
    ...(params.sessionId ? [resolveReplyRunForCurrentSessionId(params.sessionId)] : []),
  ];
  return [...new Set(candidates)].filter((operation) =>
    isReplyOperationForSession(params, operation),
  );
}

export async function waitForReplyOperationOwnerSettlement(
  operation: ReplyOperation,
  timeoutMs: number,
): Promise<boolean> {
  const settlement = operation.ownerSettlement;
  if (!settlement) {
    return true;
  }
  return settlesWithin(settlement, resolveTimerTimeoutMs(timeoutMs, 100, 100));
}

export function expireStaleReplyRunBySessionId(
  sessionId: string,
  reason: ReplyOperationStaleReason,
  options?: Parameters<typeof expireStaleReplyOperation>[2],
): boolean {
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  return operation ? expireStaleReplyOperation(operation, reason, options) : false;
}

export function markReplyOperationGlobalLaneWaitProgress(operation: ReplyOperation): void {
  if (operation.result || operation.phase !== "waiting_for_global_lane") {
    return;
  }
  markDiagnosticRunProgress({
    sessionKey: operation.key,
    sessionId: operation.sessionId,
    reason: "global_lane:waiting",
  });
}

export function isReplyRunEvidenceStaleBySessionId(sessionId: string): boolean {
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  return operation ? isReplyRunEvidenceStale(operation) : false;
}

function allowsDirectMessageInjectionOwner(sessionKey: string): boolean {
  const operation = replyRunState.activeRunsByKey.get(sessionKey);
  return (
    !operation ||
    (!operation.result &&
      !operation.abortSignal.aborted &&
      isReplyOperationPreBackendPhase(operation.phase) &&
      !hasReplyOperationExecutionStarted(operation) &&
      !getAttachedBackend(operation))
  );
}

export const replyRunRegistry: ReplyRunRegistry = {
  begin: createReplyOperation,
  get(sessionKey) {
    const normalizedSessionKey = normalizeOptionalString(sessionKey);
    return normalizedSessionKey
      ? replyRunState.activeRunsByKey.get(normalizedSessionKey)
      : undefined;
  },
  isActive(sessionKey) {
    const normalizedSessionKey = normalizeOptionalString(sessionKey);
    return Boolean(normalizedSessionKey && replyRunState.activeRunsByKey.has(normalizedSessionKey));
  },
  bindSourceTurnId(operation, sourceTurnId) {
    // Durable admission can finish after reset has replaced this operation.
    if (
      replyRunState.activeRunsByKey.get(operation.key) !== operation ||
      operation.result ||
      operation.abortSignal.aborted
    ) {
      return;
    }
    replyRunState.sourceTurnByKey.set(operation.key, sourceTurnId);
  },
  getSourceTurnId(sessionKey) {
    const normalizedSessionKey = normalizeOptionalString(sessionKey);
    return normalizedSessionKey
      ? replyRunState.sourceTurnByKey.get(normalizedSessionKey)
      : undefined;
  },
  resolveCurrentMessageInjectionTarget(sessionKey) {
    const normalizedSessionKey = normalizeOptionalString(sessionKey);
    const operation = this.get(sessionKey);
    const resolved = resolveReplyMessageInjectionRejection({
      operation,
    });
    const backend = "injection" in resolved ? resolved.backend : undefined;
    if (!normalizedSessionKey) {
      return undefined;
    }
    if (!operation || !backend) {
      return captureDirectEmbeddedMessageInjectionTarget(normalizedSessionKey, () =>
        allowsDirectMessageInjectionOwner(normalizedSessionKey),
      );
    }
    const sourceTurnId = replyRunState.sourceTurnByKey.get(normalizedSessionKey);
    return {
      [replyMessageInjectionTargetOwner]: {
        backendIdentity: backend,
        acceptParticipant: (overlay) => operation.personalToolParticipants?.accept(overlay),
        projectToolAuthorityFingerprint: (overlay) =>
          operation.projectToolAuthorityFingerprint(overlay),
        projectToolAuthorityFingerprintAsync: (overlay) =>
          operation.projectToolAuthorityFingerprintAsync(overlay),
        resolve: (params) =>
          getAttachedBackend(operation) === backend
            ? resolveReplyMessageInjectionRejection({ ...params, operation })
            : { reason: "no_active_run" },
        recordAccepted: (options) => {
          operation.recordActivity();
          operation.markSteeredInputAccepted({ inboundAudio: options?.inboundAudio === true });
        },
        abort: () => operation.abortByUser(),
      },
      ...(backend.runId ? { runId: backend.runId } : {}),
      ...(sourceTurnId ? { sourceTurnId } : {}),
    };
  },
  resolveCurrentInterruptTarget(sessionKey) {
    const operation = this.get(sessionKey);
    return operation ? { [replyRunInterruptTargetOperation]: operation } : undefined;
  },
  abort(sessionKey) {
    return this.get(sessionKey)?.abortByUser() ?? false;
  },
  waitForIdle(sessionKey, timeoutMs, opts) {
    const normalizedSessionKey = normalizeOptionalString(sessionKey);
    if (!normalizedSessionKey || !replyRunState.activeRunsByKey.has(normalizedSessionKey)) {
      return Promise.resolve(true);
    }
    if (opts?.signal?.aborted) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const waiters = replyRunState.waitersByKey.get(normalizedSessionKey) ?? new Set();
      let abortHandler: (() => void) | undefined;
      let settled = false;
      const waiter: ReplyRunWaiter = {
        finish: (ended) => {
          if (settled) {
            return;
          }
          settled = true;
          waiters.delete(waiter);
          if (waiters.size === 0) {
            replyRunState.waitersByKey.delete(normalizedSessionKey);
          }
          if (waiter.timer) {
            clearTimeout(waiter.timer);
          }
          if (abortHandler) {
            opts?.signal?.removeEventListener("abort", abortHandler);
          }
          resolve(ended);
        },
      };
      if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs)) {
        waiter.timer = setTimeout(
          () => waiter.finish(false),
          resolveTimerTimeoutMs(timeoutMs, 100, 100),
        );
      }
      if (opts?.signal) {
        abortHandler = () => waiter.finish(false);
        opts.signal.addEventListener("abort", abortHandler, { once: true });
      }
      waiters.add(waiter);
      replyRunState.waitersByKey.set(normalizedSessionKey, waiters);
      if (!replyRunState.activeRunsByKey.has(normalizedSessionKey)) {
        waiter.finish(true);
      }
    });
  },
  resolveSessionId(sessionKey) {
    const normalizedSessionKey = normalizeOptionalString(sessionKey);
    return normalizedSessionKey
      ? replyRunState.activeSessionIdsByKey.get(normalizedSessionKey)
      : undefined;
  },
};

/** Abort and await only the captured operation; a same-key successor is never rediscovered. */
export async function interruptReplyRunTarget(
  target: ReplyRunInterruptTarget,
  timeoutMs = REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
): Promise<{ aborted: boolean; settled: boolean }> {
  const operation = target[replyRunInterruptTargetOperation];
  const aborted = operation.abortByUser();
  const settled = await waitForReplyOperationOwnerSettlement(operation, timeoutMs);
  return { aborted, settled };
}

export function resolveActiveReplyRunSessionId(sessionKey: string): string | undefined {
  return replyRunRegistry.resolveSessionId(sessionKey);
}

/** Cancels the current reply backend only when its native run identity matches exactly. */
export function supersedeReplyRunByRunId(runId: string, beforeCancel: () => void): boolean {
  const expectedRunId = normalizeOptionalString(runId);
  if (!expectedRunId) {
    return false;
  }
  for (const operation of replyRunState.activeRunsByKey.values()) {
    const backend = getAttachedBackend(operation);
    if (normalizeOptionalString(backend?.runId) !== expectedRunId) {
      continue;
    }
    return operation.supersede(beforeCancel);
  }
  return false;
}

export function resolveActiveReplyRunThreadId(sessionKey: string): string | number | undefined {
  return replyRunRegistry.get(sessionKey)?.routeThreadId;
}

export function isReplyRunActiveForSessionId(sessionId: string): boolean {
  return resolveReplyRunForCurrentSessionId(sessionId) !== undefined;
}

export function isReplyRunAbortableForCompaction(sessionId: string): boolean {
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  // Manual compaction uses this as a coordination gate: a finalizing run still
  // needs to drain even when its frozen outcome rejects the abort itself.
  return Boolean(operation && !isReplyOperationPreBackendPhase(operation.phase));
}

export function abortReplyRunBySessionId(sessionId: string): boolean {
  return resolveReplyRunForCurrentSessionId(sessionId)?.abortByUser() ?? false;
}

export { resolveReplyRunForCurrentSessionId as resolveActiveReplyOperationForSessionId };

export function forceClearReplyRunBySessionId(sessionId: string, cause?: unknown): boolean {
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  return operation ? forceClearReplyOperation(operation, cause) : false;
}

export function clearReplyRunForResetBySessionId(sessionId: string): void {
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  if (!operation || isReplyOperationPreBackendPhase(operation.phase)) {
    return;
  }
  try {
    operation.abortForRestart();
  } finally {
    // Backend cancellation may synchronously retire this operation and admit a
    // replacement. Only clear the exact archived operation resolved above.
    if (replyRunState.activeRunsByKey.get(operation.key) === operation) {
      operation.complete();
    }
  }
}

export function waitForReplyRunEndBySessionId(
  sessionId: string,
  timeoutMs?: number | null,
): Promise<boolean> {
  const waitKey = resolveReplyRunWaitKey(sessionId);
  return waitKey ? replyRunRegistry.waitForIdle(waitKey, timeoutMs) : Promise.resolve(true);
}

async function waitForReplyRunAdmissionBarrier(params: {
  barriersByKey: Map<string, ReplyRunAdmissionBarrier>;
  minimumTimeoutMs: number;
  sessionKey: string;
  signal?: AbortSignal;
  timeoutMs?: number | null;
}): Promise<ReplyRunAdmissionSettlement> {
  const deadline =
    typeof params.timeoutMs === "number"
      ? Date.now() +
        resolveTimerTimeoutMs(params.timeoutMs, params.minimumTimeoutMs, params.minimumTimeoutMs)
      : undefined;
  const sources = new Map<ReplyRunAdmissionSource["databaseIdentity"], ReplyRunAdmissionSource>();
  while (true) {
    if (params.signal?.aborted) {
      return { settled: false };
    }
    const barrier = params.barriersByKey.get(params.sessionKey);
    if (!barrier) {
      return { settled: true, ...(sources.size ? { sources: [...sources.values()] } : {}) };
    }
    const remainingMs = deadline === undefined ? undefined : deadline - Date.now();
    if (remainingMs !== undefined && remainingMs <= 0) {
      return { settled: false };
    }
    const interrupted = createDeferredCore<false>();
    const timer =
      remainingMs === undefined
        ? undefined
        : setTimeout(() => interrupted.resolve(false), Math.max(1, remainingMs));
    timer?.unref?.();
    const abortHandler = () => interrupted.resolve(false);
    params.signal?.addEventListener("abort", abortHandler, { once: true });
    if (params.signal?.aborted) {
      abortHandler();
    }
    const outcome = await Promise.race([barrier.settled.then(() => true), interrupted.promise]);
    clearTimeout(timer);
    params.signal?.removeEventListener("abort", abortHandler);
    if (!outcome) {
      return { settled: false };
    }
    for (const [identity, source] of barrier.sources) {
      sources.set(
        identity,
        mergeReplyRunAdmissionSource(
          { ...source, sessionIds: new Set(source.sessionIds) },
          sources.get(identity),
        ),
      );
    }
  }
}

export async function waitForReplyRunFollowupAdmission(
  sessionKey: string,
  timeoutMs: number,
  opts?: { signal?: AbortSignal },
): Promise<ReplyRunAdmissionSettlement> {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  return normalizedSessionKey
    ? await waitForReplyRunAdmissionBarrier({
        barriersByKey: replyRunState.followupAdmissionBarriersByKey,
        minimumTimeoutMs: 100,
        sessionKey: normalizedSessionKey,
        signal: opts?.signal,
        timeoutMs,
      })
    : { settled: true };
}

export async function waitForReplyRunSuccessorAdmission(
  sessionKey: string,
  timeoutMs?: number | null,
  opts?: { signal?: AbortSignal },
): Promise<ReplyRunAdmissionSettlement> {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  return normalizedSessionKey
    ? await waitForReplyRunAdmissionBarrier({
        barriersByKey: replyRunState.successorAdmissionBarriersByKey,
        minimumTimeoutMs: 0,
        sessionKey: normalizedSessionKey,
        signal: opts?.signal,
        timeoutMs,
      })
    : { settled: true };
}

function abortReplyRuns(
  operations: Iterable<ReplyOperation>,
  opts: {
    mode: "all" | "compacting";
    onAbortError?: (sessionId: string, error: unknown) => void;
  },
  isCurrent?: (operation: ReplyOperation) => boolean,
): number {
  let aborted = 0;
  for (const operation of operations) {
    if (isCurrent && !isCurrent(operation)) {
      continue;
    }
    try {
      if (opts.mode === "compacting" && !isReplyRunCompacting(operation)) {
        continue;
      }
      if (operation.abortForRestart()) {
        aborted += 1;
      }
    } catch (error) {
      if (operation.result?.kind === "aborted" && operation.result.code === "aborted_for_restart") {
        aborted += 1;
      }
      opts.onAbortError?.(operation.sessionId, error);
    }
  }
  return aborted;
}

export function abortActiveReplyRuns(opts: Parameters<typeof abortReplyRuns>[1]): boolean {
  return abortReplyRuns(replyRunState.activeRunsByKey.values(), opts) > 0;
}

/** Snapshot before durable marking; never cancel another instance or a replacement after the await. */
export function captureGatewayReplyRunRestartAbort(resolveGatewayContext: GatewayContextResolver) {
  const operations = Array.from(replyRunState.activeRunsByKey.values()).filter((operation) =>
    hasGatewayContextOwner(operation, resolveGatewayContext),
  );
  return (onAbortError: (sessionId: string, error: unknown) => void): number =>
    abortReplyRuns(
      operations,
      { mode: "all", onAbortError },
      (operation) =>
        replyRunState.activeRunsByKey.get(operation.key) === operation &&
        operation.lifecycleGeneration !== undefined &&
        isAgentEventLifecycleGenerationCurrent(operation.lifecycleGeneration) &&
        hasGatewayContextOwner(operation, resolveGatewayContext),
    );
}

export function getActiveReplyRunCount(): number {
  return replyRunState.activeRunsByKey.size;
}

export function listActiveReplyRunSessionIds(): string[] {
  return [...replyRunState.activeSessionIdsByKey.values()];
}

export function listActiveReplyRunSessionKeys(): string[] {
  return [...replyRunState.activeSessionIdsByKey.keys()];
}

function evictPriorLifecycleReplyRuns(): void {
  const errors: unknown[] = [];
  const attempt = (evict: () => void) => {
    try {
      evict();
      return true;
    } catch (error) {
      errors.push(error);
      return false;
    }
  };
  for (const operation of replyRunState.activeRunsByKey.values()) {
    if (
      operation.lifecycleGeneration &&
      isAgentEventLifecycleGenerationCurrent(operation.lifecycleGeneration)
    ) {
      continue;
    }
    const evict = evictReplyOperationByOperation.get(operation);
    if (evict) {
      if (attempt(evict)) {
        continue;
      }
    } else {
      // Pre-generation hot-loaded operations have no retained callback, but their
      // public method still closes over the module instance that owns the backend.
      attempt(() => {
        if (!operation.abortForRestart()) {
          throw new Error(`Stale reply operation was not abortable: ${operation.key}`);
        }
      });
      // Admission stays occupied until the old closure clears it. If abort
      // synchronously clears and replaces the slot, its captured stateCleared
      // makes this completion idempotent instead of erasing the replacement.
      attempt(() => operation.complete());
    }
    attempt(() => {
      clearReplyRunState({
        sessionKey: operation.key,
        sessionId: operation.sessionId,
        operation,
      });
    });
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to abort stale reply runs");
  }
}

registerAgentEventLifecycleRotationHandler("reply-runs", evictPriorLifecycleReplyRuns);

const replyRunRegistryTestApi = {
  resetReplyRunRegistry(): void {
    for (const [sessionKey, sessionId] of replyRunState.activeSessionIdsByKey) {
      markDiagnosticRunProgress({
        sessionKey,
        sessionId,
        reason: "reply_operation:registry_reset",
      });
    }
    replyRunState.activeRunsByKey.clear();
    replyRunState.activeSessionIdsByKey.clear();
    replyRunState.activeKeysBySessionId.clear();
    replyRunState.waitKeysBySessionId.clear();
    replyRunState.sourceTurnByKey.clear();
    replyRunState.completionObservationsByKey?.clear();
    replyRunSettle.resetReplyRunSettleTimersForTesting();
    for (const waiters of replyRunState.waitersByKey.values()) {
      for (const waiter of waiters) {
        waiter.finish(false);
      }
    }
    replyRunState.waitersByKey.clear();
    replyRunState.followupAdmissionBarriersByKey.clear();
    replyRunState.successorAdmissionBarriersByKey.clear();
  },
};

if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.replyRunRegistryTestApi")] =
    replyRunRegistryTestApi;
}
