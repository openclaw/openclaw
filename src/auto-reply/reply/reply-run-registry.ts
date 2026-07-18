// Tracks active reply runs so stop, queue, and status commands can coordinate.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  createAgentRunRestartAbortError,
  isAgentRunRestartAbortReason,
} from "../../agents/run-termination.js";
import { areDiagnosticsEnabledForProcess } from "../../infra/diagnostic-events.js";
import {
  BLOCKED_TOOL_CALL_ABORT_FLOOR_MS,
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticEmbeddedRunEnded,
  markDiagnosticEmbeddedRunStarted,
} from "../../logging/diagnostic-run-activity.js";
import { diagnosticLogger as diag } from "../../logging/diagnostic-runtime.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { resolveTimerTimeoutMs } from "../../shared/number-coercion.js";
import type { ReplyFollowupAdmissionBarrierTimeoutPolicy } from "./reply-dispatcher.types.js";

export type ReplyRunKey = string;

export type ReplyBackendKind = "embedded" | "cli";

export type ReplyBackendCancelReason = "user_abort" | "restart" | "superseded";

export type ReplyBackendHandle = {
  readonly kind: ReplyBackendKind;
  cancel(reason?: ReplyBackendCancelReason): void;
  isStreaming(): boolean;
  queueMessage?: (text: string) => Promise<void>;
  /**
   * Compatibility-only hook so legacy "abort compacting runs" paths can still
   * find embedded runs that are compacting during the main run phase.
   */
  isCompacting?: () => boolean;
};

export type ReplyOperationPhase =
  | "queued"
  | "preflight_compacting"
  | "memory_flushing"
  | "running"
  | "completed"
  | "failed"
  | "aborted";

export type ReplyOperationFailureCode =
  | "gateway_draining"
  | "command_lane_cleared"
  | "aborted_by_user"
  | "session_corruption_reset"
  | "run_stalled"
  | "run_failed";

export type ReplyOperationAbortCode = "aborted_by_user" | "aborted_for_restart";

export type ReplyOperationResult =
  | { kind: "completed" }
  | { kind: "failed"; code: ReplyOperationFailureCode; cause?: unknown }
  | { kind: "aborted"; code: ReplyOperationAbortCode };

export type ReplyOperation = {
  readonly key: ReplyRunKey;
  readonly sessionId: string;
  readonly routeThreadId?: string | number;
  readonly abortSignal: AbortSignal;
  readonly resetTriggered: boolean;
  readonly phase: ReplyOperationPhase;
  readonly result: ReplyOperationResult | null;
  readonly startedAtMs: number;
  readonly lastActivityAtMs: number;
  recordActivity(): void;
  setPhase(next: "queued" | "preflight_compacting" | "memory_flushing" | "running"): void;
  updateSessionId(nextSessionId: string): void;
  attachBackend(handle: ReplyBackendHandle): void;
  detachBackend(handle: ReplyBackendHandle): void;
  /**
   * Keep a failed operation active until complete() releases the session lane.
   * Dispatch uses this while a user-visible failure payload still needs delivery.
   */
  retainFailureUntilComplete(): void;
  complete(): void;
  /**
   * Complete the operation, clear active-run state, then run follow-up work.
   * Use when the follow-up can create another ReplyOperation for this session.
   */
  completeThen(afterClear: () => void): void;
  /**
   * Clear active-run state immediately, but delay registered after-clear work
   * until delivery or another external barrier settles.
   */
  completeWithAfterClearBarrier(
    barrier: PromiseLike<unknown>,
    timeout?: number | ReplyFollowupAdmissionBarrierTimeoutPolicy,
  ): void;
  fail(code: Exclude<ReplyOperationFailureCode, "aborted_by_user">, cause?: unknown): void;
  abortByUser(): void;
  abortForRestart(): void;
};

export type ReplyRunRegistry = {
  begin(params: {
    sessionKey: string;
    sessionId: string;
    resetTriggered: boolean;
    routeThreadId?: string | number;
    upstreamAbortSignal?: AbortSignal;
  }): ReplyOperation;
  get(sessionKey: string): ReplyOperation | undefined;
  isActive(sessionKey: string): boolean;
  isStreaming(sessionKey: string): boolean;
  abort(sessionKey: string): boolean;
  waitForIdle(
    sessionKey: string,
    timeoutMs?: number,
    opts?: { signal?: AbortSignal },
  ): Promise<boolean>;
  resolveSessionId(sessionKey: string): string | undefined;
};

type ReplyRunWaiter = {
  finish: (ended: boolean) => void;
  timer?: NodeJS.Timeout;
};

type ReplyRunFollowupAdmissionBarrier = {
  settled: Promise<void>;
  sessionId: string;
};

type ReplyRunState = {
  activeRunsByKey: Map<string, ReplyOperation>;
  activeSessionIdsByKey: Map<string, string>;
  activeKeysBySessionId: Map<string, string>;
  waitKeysBySessionId: Map<string, string>;
  waitersByKey: Map<string, Set<ReplyRunWaiter>>;
  followupAdmissionBarriersByKey: Map<string, ReplyRunFollowupAdmissionBarrier>;
};

const REPLY_RUN_STATE_KEY = Symbol.for("openclaw.replyRunRegistry");

const replyRunState = resolveGlobalSingleton<ReplyRunState>(REPLY_RUN_STATE_KEY, () => ({
  activeRunsByKey: new Map<string, ReplyOperation>(),
  activeSessionIdsByKey: new Map<string, string>(),
  activeKeysBySessionId: new Map<string, string>(),
  waitKeysBySessionId: new Map<string, string>(),
  waitersByKey: new Map<string, Set<ReplyRunWaiter>>(),
  followupAdmissionBarriersByKey: new Map<string, ReplyRunFollowupAdmissionBarrier>(),
}));
replyRunState.followupAdmissionBarriersByKey ??= new Map();

export const REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS = 15_000;
// Terminal results must release the lane even if the owner never resumes.
// Without this, abort/failure can leave the session wedged until process restart.
export const REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS = 60_000;
// Visible human turns may reclaim only runs with no real progress for this window.
// Timers and user-message injection never refresh activity; agent events do.
export const REPLY_RUN_STALE_TAKEOVER_MS = 10 * 60_000;

export type ReplyOperationStaleReason = "terminal_unreleased" | "no_activity" | "stuck_recovery";

export class ReplyRunAlreadyActiveError extends Error {
  constructor(sessionKey: string) {
    super(`Reply run already active for ${sessionKey}`);
    this.name = "ReplyRunAlreadyActiveError";
  }
}

export class ReplyRunFollowupAdmissionBlockedError extends Error {
  constructor(sessionKey: string) {
    super(`Reply follow-up admission is blocked for ${sessionKey}`);
    this.name = "ReplyRunFollowupAdmissionBlockedError";
  }
}

function createUserAbortError(): Error {
  const err = new Error("Reply operation aborted by user");
  err.name = "AbortError";
  return err;
}

function registerWaitSessionId(sessionKey: string, sessionId: string): void {
  replyRunState.waitKeysBySessionId.set(sessionId, sessionKey);
}

function clearWaitSessionIds(sessionKey: string): void {
  for (const [sessionId, mappedKey] of replyRunState.waitKeysBySessionId) {
    if (mappedKey === sessionKey) {
      replyRunState.waitKeysBySessionId.delete(sessionId);
    }
  }
}

function notifyReplyRunEnded(sessionKey: string): void {
  const waiters = replyRunState.waitersByKey.get(sessionKey);
  if (!waiters || waiters.size === 0) {
    return;
  }
  replyRunState.waitersByKey.delete(sessionKey);
  for (const waiter of waiters) {
    waiter.finish(true);
  }
}

function resolveReplyRunForCurrentSessionId(sessionId: string): ReplyOperation | undefined {
  const normalizedSessionId = normalizeOptionalString(sessionId);
  if (!normalizedSessionId) {
    return undefined;
  }
  const sessionKey = replyRunState.activeKeysBySessionId.get(normalizedSessionId);
  if (!sessionKey) {
    return undefined;
  }
  return replyRunState.activeRunsByKey.get(sessionKey);
}

function resolveReplyRunWaitKey(sessionId: string): string | undefined {
  const normalizedSessionId = normalizeOptionalString(sessionId);
  if (!normalizedSessionId) {
    return undefined;
  }
  return (
    replyRunState.activeKeysBySessionId.get(normalizedSessionId) ??
    replyRunState.waitKeysBySessionId.get(normalizedSessionId)
  );
}

function isReplyRunCompacting(operation: ReplyOperation): boolean {
  if (operation.phase === "preflight_compacting" || operation.phase === "memory_flushing") {
    return true;
  }
  if (operation.phase !== "running") {
    return false;
  }
  const backend = getAttachedBackend(operation);
  return backend?.isCompacting?.() ?? false;
}

const attachedBackendByOperation = new WeakMap<ReplyOperation, ReplyBackendHandle>();
const afterClearCallbacksByOperation = new WeakMap<
  ReplyOperation,
  Set<(sessionId: string) => void>
>();
const terminalSettleTimersByOperation = new WeakMap<ReplyOperation, NodeJS.Timeout>();
const terminalSettleTimers = new Set<NodeJS.Timeout>();
const expireReplyOperationByOperation = new WeakMap<
  ReplyOperation,
  (reason: ReplyOperationStaleReason) => boolean
>();

function getAttachedBackend(operation: ReplyOperation): ReplyBackendHandle | undefined {
  return attachedBackendByOperation.get(operation);
}

/** Run work after an operation no longer owns its session lane. */
export function runAfterReplyOperationClear(
  operation: ReplyOperation,
  afterClear: (sessionId: string) => void,
): void {
  if (replyRunState.activeRunsByKey.get(operation.key) !== operation) {
    afterClear(operation.sessionId);
    return;
  }
  const callbacks =
    afterClearCallbacksByOperation.get(operation) ?? new Set<(sessionId: string) => void>();
  callbacks.add(afterClear);
  afterClearCallbacksByOperation.set(operation, callbacks);
}

function flushReplyOperationAfterClear(operation: ReplyOperation, sessionId: string): void {
  const callbacks = afterClearCallbacksByOperation.get(operation);
  if (!callbacks) {
    return;
  }
  afterClearCallbacksByOperation.delete(operation);
  for (const callback of callbacks) {
    callback(sessionId);
  }
}

function formatReplyOperationResult(result: ReplyOperationResult | null): string {
  if (!result) {
    return "none";
  }
  return result.kind === "completed" ? result.kind : `${result.kind}:${result.code}`;
}

function clearTerminalSettleTimer(operation: ReplyOperation): void {
  const timer = terminalSettleTimersByOperation.get(operation);
  if (!timer) {
    return;
  }
  clearTimeout(timer);
  terminalSettleTimers.delete(timer);
  terminalSettleTimersByOperation.delete(operation);
}

function registerFollowupAdmissionBarrier(
  sessionKey: string,
  sessionId: string,
  barrier: PromiseLike<unknown>,
  timeout: number | ReplyFollowupAdmissionBarrierTimeoutPolicy = REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
): ReplyRunFollowupAdmissionBarrier {
  const barriersByKey = replyRunState.followupAdmissionBarriersByKey;
  const previous = barriersByKey.get(sessionKey)?.settled;
  // Owners may extend this for bounded retry envelopes; all barriers retain a failsafe.
  const current = new Promise<void>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const schedule = (delayMs: number, callback: () => void) => {
      timer = setTimeout(callback, delayMs);
      timer.unref?.();
    };
    if (typeof timeout === "number") {
      schedule(resolveTimerTimeoutMs(timeout, REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS), finish);
    } else {
      const startedAt = Date.now();
      const maxTimeoutMs = resolveTimerTimeoutMs(
        timeout.maxTimeoutMs,
        REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
      );
      const checkOwnerActivity = () => {
        const remainingMs = maxTimeoutMs - (Date.now() - startedAt);
        if (remainingMs <= 0) {
          finish();
          return;
        }
        let shouldExtend: boolean;
        try {
          shouldExtend = timeout.shouldExtend();
        } catch {
          finish();
          return;
        }
        if (!shouldExtend) {
          finish();
          return;
        }
        schedule(Math.min(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS, remainingMs), checkOwnerActivity);
      };
      schedule(Math.min(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS, maxTimeoutMs), checkOwnerActivity);
    }
    void Promise.resolve(barrier).then(finish, finish);
  });
  const settled = previous ? Promise.all([previous, current]).then(() => undefined) : current;
  const entry = { settled, sessionId };
  barriersByKey.set(sessionKey, entry);
  void settled.then(() => {
    if (barriersByKey.get(sessionKey) === entry) {
      barriersByKey.delete(sessionKey);
    }
  });
  return entry;
}

function updateFollowupAdmissionSessionId(sessionKey: string, sessionId: string): void {
  const barrier = replyRunState.followupAdmissionBarriersByKey.get(sessionKey);
  if (barrier) {
    barrier.sessionId = sessionId;
  }
}

function clearReplyRunState(params: { sessionKey: string; sessionId: string }): void {
  replyRunState.activeRunsByKey.delete(params.sessionKey);
  replyRunState.activeSessionIdsByKey.delete(params.sessionKey);
  if (replyRunState.activeKeysBySessionId.get(params.sessionId) === params.sessionKey) {
    replyRunState.activeKeysBySessionId.delete(params.sessionId);
  }
  clearWaitSessionIds(params.sessionKey);
  notifyReplyRunEnded(params.sessionKey);
}

function replyRunDiagnosticWorkKey(sessionKey: string): string {
  return `reply:${sessionKey}`;
}

function markReplyRunDiagnosticWorkStarted(params: {
  sessionKey: string;
  sessionId: string;
}): void {
  markDiagnosticEmbeddedRunStarted({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workKey: replyRunDiagnosticWorkKey(params.sessionKey),
  });
}

function markReplyRunDiagnosticWorkEnded(params: { sessionKey: string; sessionId: string }): void {
  markDiagnosticEmbeddedRunEnded({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workKey: replyRunDiagnosticWorkKey(params.sessionKey),
    clearRunActivity: false,
  });
}

export function createReplyOperation(params: {
  sessionKey: string;
  sessionId: string;
  resetTriggered: boolean;
  routeThreadId?: string | number;
  upstreamAbortSignal?: AbortSignal;
  respectFollowupAdmissionBarrier?: boolean;
}): ReplyOperation {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const sessionId = normalizeOptionalString(params.sessionId);
  if (!sessionKey) {
    throw new Error("Reply operations require a canonical sessionKey");
  }
  if (!sessionId) {
    throw new Error("Reply operations require a sessionId");
  }
  if (
    params.respectFollowupAdmissionBarrier &&
    replyRunState.followupAdmissionBarriersByKey.has(sessionKey)
  ) {
    throw new ReplyRunFollowupAdmissionBlockedError(sessionKey);
  }
  if (replyRunState.activeRunsByKey.has(sessionKey)) {
    throw new ReplyRunAlreadyActiveError(sessionKey);
  }

  const controller = new AbortController();
  let currentSessionId = sessionId;
  let phase: ReplyOperationPhase = "queued";
  let result: ReplyOperationResult | null = null;
  const startedAtMs = Date.now();
  let lastActivityAtMs = startedAtMs;
  let stateCleared = false;
  let retainFailureUntilComplete = false;
  const upstreamAbortSignal = params.upstreamAbortSignal;
  let upstreamAbortHandler: (() => void) | undefined;

  const detachUpstreamAbort = () => {
    if (!upstreamAbortHandler) {
      return;
    }
    upstreamAbortSignal?.removeEventListener("abort", upstreamAbortHandler);
    upstreamAbortHandler = undefined;
  };

  const recordActivity = () => {
    lastActivityAtMs = Date.now();
  };
  const setResult = (next: ReplyOperationResult) => {
    result = next;
    recordActivity();
  };

  const clearState = (
    afterClearBarrier?: PromiseLike<unknown>,
    followupAdmissionBarrierTimeout?: number | ReplyFollowupAdmissionBarrierTimeoutPolicy,
  ) => {
    if (stateCleared) {
      return;
    }
    stateCleared = true;
    clearTerminalSettleTimer(operation);
    expireReplyOperationByOperation.delete(operation);
    detachUpstreamAbort();
    const registeredBarrier = afterClearBarrier
      ? registerFollowupAdmissionBarrier(
          sessionKey,
          currentSessionId,
          afterClearBarrier,
          followupAdmissionBarrierTimeout,
        )
      : undefined;
    updateFollowupAdmissionSessionId(sessionKey, currentSessionId);
    markReplyRunDiagnosticWorkEnded({ sessionKey, sessionId: currentSessionId });
    clearReplyRunState({
      sessionKey,
      sessionId: currentSessionId,
    });
    if (!registeredBarrier) {
      flushReplyOperationAfterClear(operation, currentSessionId);
      return;
    }
    void registeredBarrier.settled.then(() =>
      flushReplyOperationAfterClear(operation, registeredBarrier.sessionId),
    );
  };

  const abortInternally = (reason?: unknown) => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };

  const scheduleTerminalSettle = () => {
    if (stateCleared || terminalSettleTimersByOperation.has(operation)) {
      return;
    }
    // Retained terminal results get one delivery grace window, not a second
    // lifetime. Expiry frees the lane and flushes lifecycle after-clear work —
    // including skipping any delivery barrier the owner never got to register;
    // followups may then interleave with a still-draining terminal delivery.
    const timer = setTimeout(() => {
      if (replyRunState.activeRunsByKey.get(sessionKey) !== operation) {
        clearTerminalSettleTimer(operation);
        return;
      }
      diag.warn(
        `reply run terminal settle: forced release sessionKey=${sessionKey} phase=${phase} result=${formatReplyOperationResult(
          result,
        )} ageMs=${Date.now() - lastActivityAtMs} ranForMs=${Date.now() - startedAtMs}`,
      );
      clearState();
    }, REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS);
    timer.unref?.();
    terminalSettleTimersByOperation.set(operation, timer);
    terminalSettleTimers.add(timer);
  };

  const abortWithReason = (
    reason: ReplyBackendCancelReason,
    abortReason: unknown,
    opts?: { abortedCode?: ReplyOperationAbortCode },
  ) => {
    if (opts?.abortedCode && !result) {
      setResult({ kind: "aborted", code: opts.abortedCode });
      detachUpstreamAbort();
    }
    phase = "aborted";
    abortInternally(abortReason);
    getAttachedBackend(operation)?.cancel(reason);
  };

  const operation: ReplyOperation = {
    get key() {
      return sessionKey;
    },
    get sessionId() {
      return currentSessionId;
    },
    get routeThreadId() {
      return params.routeThreadId;
    },
    get abortSignal() {
      return controller.signal;
    },
    get resetTriggered() {
      return params.resetTriggered;
    },
    get phase() {
      return phase;
    },
    get result() {
      return result;
    },
    get startedAtMs() {
      return startedAtMs;
    },
    get lastActivityAtMs() {
      return lastActivityAtMs;
    },
    recordActivity,
    setPhase(next) {
      if (result) {
        return;
      }
      recordActivity();
      phase = next;
    },
    updateSessionId(nextSessionId) {
      if (result) {
        return;
      }
      const normalizedNextSessionId = normalizeOptionalString(nextSessionId);
      if (!normalizedNextSessionId || normalizedNextSessionId === currentSessionId) {
        return;
      }
      recordActivity();
      if (
        replyRunState.activeKeysBySessionId.has(normalizedNextSessionId) &&
        replyRunState.activeKeysBySessionId.get(normalizedNextSessionId) !== sessionKey
      ) {
        throw new Error(
          `Cannot rebind reply operation ${sessionKey} to active session ${normalizedNextSessionId}`,
        );
      }
      replyRunState.activeKeysBySessionId.delete(currentSessionId);
      registerWaitSessionId(sessionKey, currentSessionId);
      currentSessionId = normalizedNextSessionId;
      updateFollowupAdmissionSessionId(sessionKey, currentSessionId);
      replyRunState.activeSessionIdsByKey.set(sessionKey, currentSessionId);
      replyRunState.activeKeysBySessionId.set(currentSessionId, sessionKey);
      registerWaitSessionId(sessionKey, currentSessionId);
      markReplyRunDiagnosticWorkStarted({ sessionKey, sessionId: currentSessionId });
    },
    attachBackend(handle) {
      if (result) {
        handle.cancel(
          result.kind === "aborted"
            ? result.code === "aborted_for_restart"
              ? "restart"
              : "user_abort"
            : "superseded",
        );
        return;
      }
      recordActivity();
      attachedBackendByOperation.set(operation, handle);
      if (controller.signal.aborted) {
        handle.cancel("superseded");
      }
    },
    detachBackend(handle) {
      if (getAttachedBackend(operation) === handle) {
        attachedBackendByOperation.delete(operation);
      }
    },
    retainFailureUntilComplete() {
      retainFailureUntilComplete = true;
    },
    complete() {
      if (!result) {
        setResult({ kind: "completed" });
        phase = "completed";
      }
      clearState();
    },
    completeThen(afterClear) {
      runAfterReplyOperationClear(operation, afterClear);
      operation.complete();
    },
    completeWithAfterClearBarrier(barrier, timeoutMs) {
      if (!result) {
        setResult({ kind: "completed" });
        phase = "completed";
      }
      clearState(barrier, timeoutMs);
    },
    fail(code, cause) {
      if (!result) {
        setResult({ kind: "failed", code, cause });
        phase = "failed";
      }
      if (!retainFailureUntilComplete) {
        clearState();
      } else {
        scheduleTerminalSettle();
      }
    },
    abortByUser() {
      if (result) {
        return;
      }
      const phaseBeforeAbort = phase;
      abortWithReason("user_abort", createUserAbortError(), {
        abortedCode: "aborted_by_user",
      });
      if (phaseBeforeAbort === "queued") {
        clearState();
      } else {
        scheduleTerminalSettle();
      }
    },
    abortForRestart() {
      if (result) {
        return;
      }
      const phaseBeforeAbort = phase;
      abortWithReason("restart", createAgentRunRestartAbortError(), {
        abortedCode: "aborted_for_restart",
      });
      if (phaseBeforeAbort === "queued") {
        clearState();
      } else {
        scheduleTerminalSettle();
      }
    },
  };

  expireReplyOperationByOperation.set(operation, (reason) => {
    if (replyRunState.activeRunsByKey.get(sessionKey) !== operation) {
      return false;
    }
    // Set the terminal result BEFORE cancelling the backend: cancel can
    // synchronously re-enter abortByUser() from the run loop's abort handler,
    // which would stamp aborted_by_user and misattribute a watchdog expiry.
    if (!result) {
      setResult({ kind: "failed", code: "run_stalled" });
      phase = "failed";
    }
    getAttachedBackend(operation)?.cancel("superseded");
    abortInternally(createUserAbortError());
    diag.warn(
      `reply run stale takeover: forced release sessionKey=${sessionKey} reason=${reason} phase=${phase} result=${formatReplyOperationResult(
        result,
      )} ageMs=${Date.now() - lastActivityAtMs} ranForMs=${Date.now() - startedAtMs}`,
    );
    clearState();
    return true;
  });

  replyRunState.activeRunsByKey.set(sessionKey, operation);
  replyRunState.activeSessionIdsByKey.set(sessionKey, currentSessionId);
  replyRunState.activeKeysBySessionId.set(currentSessionId, sessionKey);
  registerWaitSessionId(sessionKey, currentSessionId);
  markReplyRunDiagnosticWorkStarted({ sessionKey, sessionId: currentSessionId });

  if (upstreamAbortSignal) {
    const abortFromUpstream = () => {
      if (result) {
        return;
      }
      const restart = isAgentRunRestartAbortReason(upstreamAbortSignal.reason);
      const phaseBeforeAbort = phase;
      abortWithReason(restart ? "restart" : "user_abort", upstreamAbortSignal.reason, {
        abortedCode: restart ? "aborted_for_restart" : "aborted_by_user",
      });
      if (phaseBeforeAbort === "queued") {
        clearState();
      } else {
        scheduleTerminalSettle();
      }
    };
    if (upstreamAbortSignal.aborted) {
      abortFromUpstream();
    } else {
      upstreamAbortHandler = abortFromUpstream;
      upstreamAbortSignal.addEventListener("abort", upstreamAbortHandler, { once: true });
    }
  }

  return operation;
}

export function expireStaleReplyOperation(
  operation: ReplyOperation,
  reason: ReplyOperationStaleReason,
): boolean {
  return expireReplyOperationByOperation.get(operation)?.(reason) ?? false;
}

export function expireStaleReplyRunBySessionId(
  sessionId: string,
  reason: ReplyOperationStaleReason,
): boolean {
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  return operation ? expireStaleReplyOperation(operation, reason) : false;
}

export const replyRunRegistry: ReplyRunRegistry = {
  begin(params) {
    return createReplyOperation(params);
  },
  get(sessionKey) {
    const normalizedSessionKey = normalizeOptionalString(sessionKey);
    if (!normalizedSessionKey) {
      return undefined;
    }
    return replyRunState.activeRunsByKey.get(normalizedSessionKey);
  },
  isActive(sessionKey) {
    const normalizedSessionKey = normalizeOptionalString(sessionKey);
    if (!normalizedSessionKey) {
      return false;
    }
    return replyRunState.activeRunsByKey.has(normalizedSessionKey);
  },
  isStreaming(sessionKey) {
    const operation = this.get(sessionKey);
    if (!operation || operation.phase !== "running") {
      return false;
    }
    return getAttachedBackend(operation)?.isStreaming() ?? false;
  },
  abort(sessionKey) {
    const operation = this.get(sessionKey);
    if (!operation) {
      return false;
    }
    operation.abortByUser();
    return true;
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
    if (!normalizedSessionKey) {
      return undefined;
    }
    return replyRunState.activeSessionIdsByKey.get(normalizedSessionKey);
  },
};

export function resolveActiveReplyRunSessionId(sessionKey: string): string | undefined {
  return replyRunRegistry.resolveSessionId(sessionKey);
}

export function resolveActiveReplyRunThreadId(sessionKey: string): string | number | undefined {
  return replyRunRegistry.get(sessionKey)?.routeThreadId;
}

export function isReplyRunActiveForSessionId(sessionId: string): boolean {
  return resolveReplyRunForCurrentSessionId(sessionId) !== undefined;
}

export function isReplyRunAbortableForCompaction(sessionId: string): boolean {
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  return Boolean(operation && operation.phase !== "queued");
}

export function isReplyRunStreamingForSessionId(sessionId: string): boolean {
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  if (!operation || operation.phase !== "running") {
    return false;
  }
  return getAttachedBackend(operation)?.isStreaming() ?? false;
}

export function resolveReplyRunStaleThresholdMs(operation: ReplyOperation): number {
  const activity = getDiagnosticSessionActivitySnapshot({
    sessionId: operation.sessionId,
    sessionKey: operation.key,
  });
  return activity.activeWorkKind === "tool_call"
    ? Math.max(REPLY_RUN_STALE_TAKEOVER_MS, BLOCKED_TOOL_CALL_ABORT_FLOOR_MS)
    : REPLY_RUN_STALE_TAKEOVER_MS;
}

export function isReplyRunEvidenceStale(operation: ReplyOperation): boolean {
  if (operation.result) {
    return false;
  }
  const activity = getDiagnosticSessionActivitySnapshot({
    sessionId: operation.sessionId,
    sessionKey: operation.key,
  });
  const replyActivityAgeMs = Date.now() - operation.lastActivityAtMs;
  const evidenceAgeMs =
    typeof activity.lastProgressAgeMs === "number"
      ? Math.min(replyActivityAgeMs, activity.lastProgressAgeMs)
      : replyActivityAgeMs;
  return evidenceAgeMs > resolveReplyRunStaleThresholdMs(operation);
}

export function isReplyRunEvidenceStaleBySessionId(sessionId: string): boolean {
  if (!areDiagnosticsEnabledForProcess()) {
    return false;
  }
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  return operation ? isReplyRunEvidenceStale(operation) : false;
}

export function queueReplyRunMessage(sessionId: string, text: string): boolean {
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  const backend = operation ? getAttachedBackend(operation) : undefined;
  if (!operation || operation.phase !== "running" || !backend?.queueMessage) {
    return false;
  }
  // Injection is not liveness evidence. Reject an evidence-dead backend so the
  // caller can deliver directly instead of swallowing the message in a stale run.
  if (isReplyRunEvidenceStaleBySessionId(sessionId)) {
    return false;
  }
  if (!backend.isStreaming()) {
    return false;
  }
  // Injection is user input, not run evidence: stamping activity here would let
  // sub-10-minute user messages re-arm a wedged run's staleness window forever.
  const queued = backend.queueMessage(text);
  queued.catch((error: unknown) => {
    diag.debug(`queued reply run message rejected: sessionId=${sessionId} error=${String(error)}`);
  });
  return true;
}

export function abortReplyRunBySessionId(sessionId: string): boolean {
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  if (!operation) {
    return false;
  }
  operation.abortByUser();
  return true;
}

export function forceClearReplyRunBySessionId(sessionId: string, cause?: unknown): boolean {
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  if (!operation) {
    return false;
  }
  operation.fail("run_failed", cause);
  operation.complete();
  return true;
}

export function waitForReplyRunEndBySessionId(
  sessionId: string,
  timeoutMs: number,
): Promise<boolean> {
  const waitKey = resolveReplyRunWaitKey(sessionId);
  if (!waitKey) {
    return Promise.resolve(true);
  }
  return replyRunRegistry.waitForIdle(waitKey, timeoutMs);
}

export async function waitForReplyRunFollowupAdmission(
  sessionKey: string,
  timeoutMs: number,
  opts?: { signal?: AbortSignal },
): Promise<{ settled: boolean; sessionId?: string }> {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  if (!normalizedSessionKey) {
    return { settled: true };
  }
  const resolvedTimeoutMs = resolveTimerTimeoutMs(timeoutMs, 100, 100);
  const deadline = Date.now() + resolvedTimeoutMs;
  let sessionId: string | undefined;
  while (true) {
    if (opts?.signal?.aborted) {
      return { settled: false };
    }
    const barrier = replyRunState.followupAdmissionBarriersByKey.get(normalizedSessionKey);
    if (!barrier) {
      return { settled: true, sessionId };
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return { settled: false };
    }
    let timer: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;
    const outcome = await Promise.race([
      barrier.settled.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), remainingMs);
        timer.unref?.();
      }),
      ...(opts?.signal
        ? [
            new Promise<boolean>((resolve) => {
              abortHandler = () => resolve(false);
              opts.signal?.addEventListener("abort", abortHandler, { once: true });
            }),
          ]
        : []),
    ]);
    if (timer) {
      clearTimeout(timer);
    }
    if (abortHandler) {
      opts?.signal?.removeEventListener("abort", abortHandler);
    }
    if (!outcome) {
      return { settled: false };
    }
    sessionId = barrier.sessionId;
  }
}

export function abortActiveReplyRuns(opts: { mode: "all" | "compacting" }): boolean {
  let aborted = false;
  for (const operation of replyRunState.activeRunsByKey.values()) {
    if (opts.mode === "compacting" && !isReplyRunCompacting(operation)) {
      continue;
    }
    operation.abortForRestart();
    aborted = true;
  }
  return aborted;
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

export const testing = {
  resetReplyRunRegistry(): void {
    for (const [sessionKey, sessionId] of replyRunState.activeSessionIdsByKey) {
      markReplyRunDiagnosticWorkEnded({ sessionKey, sessionId });
    }
    replyRunState.activeRunsByKey.clear();
    replyRunState.activeSessionIdsByKey.clear();
    replyRunState.activeKeysBySessionId.clear();
    replyRunState.waitKeysBySessionId.clear();
    for (const timer of terminalSettleTimers) {
      clearTimeout(timer);
    }
    terminalSettleTimers.clear();
    for (const waiters of replyRunState.waitersByKey.values()) {
      for (const waiter of waiters) {
        waiter.finish(false);
      }
    }
    replyRunState.waitersByKey.clear();
    replyRunState.followupAdmissionBarriersByKey.clear();
  },
};
export { testing as __testing };
