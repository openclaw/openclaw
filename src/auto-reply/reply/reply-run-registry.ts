import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

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
  | "run_failed";

export type ReplyOperationAbortCode = "aborted_by_user" | "aborted_for_restart";

export type ReplyOperationResult =
  | { kind: "completed" }
  | { kind: "failed"; code: ReplyOperationFailureCode; cause?: unknown }
  | { kind: "aborted"; code: ReplyOperationAbortCode };

export type ReplyOperation = {
  readonly key: ReplyRunKey;
  readonly sessionId: string;
  readonly abortSignal: AbortSignal;
  readonly resetTriggered: boolean;
  readonly phase: ReplyOperationPhase;
  readonly result: ReplyOperationResult | null;
  setPhase(next: "queued" | "preflight_compacting" | "memory_flushing" | "running"): void;
  updateSessionId(nextSessionId: string): void;
  attachBackend(handle: ReplyBackendHandle): void;
  detachBackend(handle: ReplyBackendHandle): void;
  complete(): void;
  fail(code: Exclude<ReplyOperationFailureCode, "aborted_by_user">, cause?: unknown): void;
  abortByUser(opts?: { skipNotify?: boolean }): void;
  abortForRestart(): void;
};

export type ReplyRunRegistry = {
  begin(params: {
    sessionKey: string;
    sessionId: string;
    resetTriggered: boolean;
    upstreamAbortSignal?: AbortSignal;
  }): ReplyOperation;
  get(sessionKey: string): ReplyOperation | undefined;
  isActive(sessionKey: string): boolean;
  isStreaming(sessionKey: string): boolean;
  abort(sessionKey: string): boolean;
  waitForIdle(sessionKey: string, timeoutMs?: number): Promise<boolean>;
  resolveSessionId(sessionKey: string): string | undefined;
};

type ReplyRunWaiter = {
  resolve: (ended: boolean) => void;
  timer: NodeJS.Timeout;
};

type ReplyRunState = {
  activeRunsByKey: Map<string, ReplyOperation>;
  activeSessionIdsByKey: Map<string, string>;
  activeKeysBySessionId: Map<string, string>;
  waitKeysBySessionId: Map<string, string>;
  waitersByKey: Map<string, Set<ReplyRunWaiter>>;
  /**
   * Monotonic counter of successful reply-operation creations per sessionKey.
   * Incremented on every successful `createReplyOperation` call (including
   * force-supersede and followup-runner creations).  Never decremented, never
   * reset on completion — callers that captured a seq value can compare it
   * after an await to detect whether any new operation slipped in during
   * the wait window, even if the registry is idle again by the time they
   * recheck.  Used by the interrupt-mode retry path in agent-runner to
   * reject older requests whose supersede window was consumed by a newer
   * replacement that already ran to completion.
   */
  createSeqByKey: Map<string, number>;
};

const REPLY_RUN_STATE_KEY = Symbol.for("openclaw.replyRunRegistry");

const replyRunState = resolveGlobalSingleton<ReplyRunState>(REPLY_RUN_STATE_KEY, () => ({
  activeRunsByKey: new Map<string, ReplyOperation>(),
  activeSessionIdsByKey: new Map<string, string>(),
  activeKeysBySessionId: new Map<string, string>(),
  waitKeysBySessionId: new Map<string, string>(),
  waitersByKey: new Map<string, Set<ReplyRunWaiter>>(),
  createSeqByKey: new Map<string, number>(),
}));

export class ReplyRunAlreadyActiveError extends Error {
  constructor(sessionKey: string) {
    super(`Reply run already active for ${sessionKey}`);
    this.name = "ReplyRunAlreadyActiveError";
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

function notifyReplyRunEnded(sessionKey: string): void {
  const waiters = replyRunState.waitersByKey.get(sessionKey);
  if (!waiters || waiters.size === 0) {
    return;
  }
  replyRunState.waitersByKey.delete(sessionKey);
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(true);
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

function getAttachedBackend(operation: ReplyOperation): ReplyBackendHandle | undefined {
  return attachedBackendByOperation.get(operation);
}

function clearReplyRunState(params: {
  sessionKey: string;
  sessionId: string;
  /** If provided, only clear if the currently registered operation is this
   *  exact object.  This prevents a stale operation's finally block from
   *  deleting a replacement that was registered via force-supersede — even
   *  when both operations share the same sessionId. */
  expectedOperation?: ReplyOperation;
  /** When true, skip notifying waiters. Used during force-supersede so that
   *  a replacement operation can register without briefly resolving
   *  waitForReplyRunEndBySessionId waiters in the gap between clearing the
   *  old operation and registering the new one. */
  skipNotify?: boolean;
}): void {
  // Identity-check before deletion: if another operation has already replaced
  // us for this sessionKey (e.g. after a force-supersede via createReplyOperation
  // with force:true), we must NOT delete the new operation's entries.
  //
  // When `expectedOperation` is provided (all internal callers), we use strict
  // object-identity comparison. When omitted, we fall back to sessionId
  // comparison — but note this is NOT safe when the replacement shares the same
  // sessionId (e.g. interrupt-mode retry). External callers that hit this path
  // should be migrated to pass `expectedOperation`.
  const currentEntry = replyRunState.activeRunsByKey.get(params.sessionKey);
  if (currentEntry) {
    const isReplaced = params.expectedOperation
      ? currentEntry !== params.expectedOperation
      : currentEntry.sessionId !== params.sessionId;
    if (isReplaced) {
      // Different operation is now registered — skip all map mutations.
      // Do NOT notify waiters: the replacement is still active, so
      // resolving waitForReplyRunEnd would incorrectly signal "idle".
      // Do NOT delete wait-key mappings: the replacement may have
      // inherited this sessionId via updateSessionId rotation, so
      // deleting it would break waitForReplyRunEndBySessionId lookups
      // for the replacement's old session ID.
      return;
    }
  }
  replyRunState.activeRunsByKey.delete(params.sessionKey);
  if (replyRunState.activeSessionIdsByKey.get(params.sessionKey) === params.sessionId) {
    replyRunState.activeSessionIdsByKey.delete(params.sessionKey);
  }
  if (replyRunState.activeKeysBySessionId.get(params.sessionId) === params.sessionKey) {
    replyRunState.activeKeysBySessionId.delete(params.sessionId);
  }
  // Clean up all wait-key aliases for this sessionKey. updateSessionId
  // registers both old and new sessionIds as wait-key aliases so that
  // waitForReplyRunEndBySessionId can resolve rotated sessionIds. When a
  // run finishes normally (no replacement), all those aliases must be
  // removed to prevent stale aliases from attaching to future runs that
  // reuse the same sessionKey.
  //
  // Skip alias cleanup during force-supersede (skipNotify === true):
  // the replacement operation inherits the same sessionKey and may need
  // the existing aliases for waitForReplyRunEndBySessionId to resolve
  // rotated sessionIds from the old run. The aliases will be cleaned up
  // when the replacement finishes normally.
  if (!params.skipNotify) {
    for (const [aliasId, mappedKey] of replyRunState.waitKeysBySessionId) {
      if (mappedKey === params.sessionKey) {
        replyRunState.waitKeysBySessionId.delete(aliasId);
      }
    }
  }
  if (!params.skipNotify) {
    notifyReplyRunEnded(params.sessionKey);
  }
}

export function createReplyOperation(params: {
  sessionKey: string;
  sessionId: string;
  resetTriggered: boolean;
  upstreamAbortSignal?: AbortSignal;
  /**
   * Supersede an existing operation for this sessionKey.
   *
   * - `true`: unconditional force — aborts and replaces whatever is registered.
   * - `{ ifStale: ReplyOperation }`: identity-gated force — only supersede
   *   when the currently registered operation is object-identical to `ifStale`.
   *   If a different operation has taken over since the caller captured the
   *   reference (e.g. a newer concurrent replacement registered during the
   *   caller's wait window), this throws `ReplyRunAlreadyActiveError` exactly
   *   like an unforced create, so the newer legitimate operation is preserved.
   *
   * Used by interrupt mode after a two-phase abort detach, where the retry
   * must not kick out a newer request that slipped in during cleanup.
   */
  force?: boolean | { ifStale: ReplyOperation };
}): ReplyOperation {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const sessionId = normalizeOptionalString(params.sessionId);
  if (!sessionKey) {
    throw new Error("Reply operations require a canonical sessionKey");
  }
  if (!sessionId) {
    throw new Error("Reply operations require a sessionId");
  }
  if (replyRunState.activeRunsByKey.has(sessionKey)) {
    const existing = replyRunState.activeRunsByKey.get(sessionKey)!;
    const shouldSupersede =
      params.force === true ||
      (typeof params.force === "object" &&
        params.force !== null &&
        params.force.ifStale === existing);
    if (shouldSupersede) {
      existing.abortByUser({ skipNotify: true });
      // For queued operations, abortByUser already cleared the registry
      // synchronously (with skipNotify). For running operations, the
      // clearReplyRunState call below handles the registry while the
      // operation's finally block will later see isReplaced and skip.
      if (replyRunState.activeRunsByKey.has(sessionKey)) {
        clearReplyRunState({
          sessionKey,
          sessionId: existing.sessionId,
          expectedOperation: existing,
          skipNotify: true,
        });
      }
    } else {
      throw new ReplyRunAlreadyActiveError(sessionKey);
    }
  }

  const controller = new AbortController();
  let currentSessionId = sessionId;
  let phase: ReplyOperationPhase = "queued";
  let result: ReplyOperationResult | null = null;
  let stateCleared = false;
  // Back-reference: set after the operation object is created so that
  // clearState() can pass it to clearReplyRunState for object-identity
  // checking.  This prevents a stale operation from deleting a
  // replacement that shares the same sessionId.
  let selfRef: ReplyOperation | undefined;

  const clearState = () => {
    if (stateCleared) {
      return;
    }
    stateCleared = true;
    clearReplyRunState({
      sessionKey,
      sessionId: currentSessionId,
      expectedOperation: selfRef,
    });
  };

  const abortInternally = (reason?: unknown) => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };

  const abortWithReason = (
    reason: ReplyBackendCancelReason,
    abortReason: unknown,
    opts?: { abortedCode?: ReplyOperationAbortCode },
  ) => {
    if (opts?.abortedCode && !result) {
      result = { kind: "aborted", code: opts.abortedCode };
    }
    phase = "aborted";
    abortInternally(abortReason);
    getAttachedBackend(operation)?.cancel(reason);
  };

  if (params.upstreamAbortSignal) {
    if (params.upstreamAbortSignal.aborted) {
      abortInternally(params.upstreamAbortSignal.reason);
    } else {
      params.upstreamAbortSignal.addEventListener(
        "abort",
        () => {
          abortInternally(params.upstreamAbortSignal?.reason);
        },
        { once: true },
      );
    }
  }

  const operation: ReplyOperation = {
    get key() {
      return sessionKey;
    },
    get sessionId() {
      return currentSessionId;
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
    setPhase(next) {
      if (result) {
        return;
      }
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
      replyRunState.activeSessionIdsByKey.set(sessionKey, currentSessionId);
      replyRunState.activeKeysBySessionId.set(currentSessionId, sessionKey);
      registerWaitSessionId(sessionKey, currentSessionId);
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
    complete() {
      if (!result) {
        result = { kind: "completed" };
        phase = "completed";
      }
      clearState();
    },
    fail(code, cause) {
      if (!result) {
        result = { kind: "failed", code, cause };
        phase = "failed";
      }
      clearState();
    },
    abortByUser(opts?: { skipNotify?: boolean }) {
      const phaseBeforeAbort = phase;
      abortWithReason("user_abort", createUserAbortError(), {
        abortedCode: "aborted_by_user",
      });
      if (phaseBeforeAbort === "queued") {
        clearReplyRunState({
          sessionKey,
          sessionId: currentSessionId,
          expectedOperation: selfRef,
          skipNotify: opts?.skipNotify,
        });
        stateCleared = true;
      }
    },
    abortForRestart() {
      const phaseBeforeAbort = phase;
      abortWithReason("restart", new Error("Reply operation aborted for restart"), {
        abortedCode: "aborted_for_restart",
      });
      if (phaseBeforeAbort === "queued") {
        clearState();
      }
    },
  };

  replyRunState.activeRunsByKey.set(sessionKey, operation);
  replyRunState.activeSessionIdsByKey.set(sessionKey, currentSessionId);
  replyRunState.activeKeysBySessionId.set(currentSessionId, sessionKey);
  registerWaitSessionId(sessionKey, currentSessionId);
  // Monotonic creation counter — never reset on completion so callers that
  // captured a seq value before an await can still detect whether another
  // operation slotted in during the wait, even if the registry is idle by
  // the time they recheck.
  replyRunState.createSeqByKey.set(
    sessionKey,
    (replyRunState.createSeqByKey.get(sessionKey) ?? 0) + 1,
  );

  // Wire up the back-reference so clearState() can pass object identity.
  selfRef = operation;

  return operation;
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
  waitForIdle(sessionKey, timeoutMs = 15_000) {
    const normalizedSessionKey = normalizeOptionalString(sessionKey);
    if (!normalizedSessionKey || !replyRunState.activeRunsByKey.has(normalizedSessionKey)) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const waiters = replyRunState.waitersByKey.get(normalizedSessionKey) ?? new Set();
      const waiter: ReplyRunWaiter = {
        resolve,
        timer: setTimeout(
          () => {
            waiters.delete(waiter);
            if (waiters.size === 0) {
              replyRunState.waitersByKey.delete(normalizedSessionKey);
            }
            resolve(false);
          },
          Math.max(100, timeoutMs),
        ),
      };
      waiters.add(waiter);
      replyRunState.waitersByKey.set(normalizedSessionKey, waiters);
      if (!replyRunState.activeRunsByKey.has(normalizedSessionKey)) {
        waiters.delete(waiter);
        if (waiters.size === 0) {
          replyRunState.waitersByKey.delete(normalizedSessionKey);
        }
        clearTimeout(waiter.timer);
        resolve(true);
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

export function isReplyRunActiveForSessionId(sessionId: string): boolean {
  return resolveReplyRunForCurrentSessionId(sessionId) !== undefined;
}

export function isReplyRunStreamingForSessionId(sessionId: string): boolean {
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  if (!operation || operation.phase !== "running") {
    return false;
  }
  return getAttachedBackend(operation)?.isStreaming() ?? false;
}

export function queueReplyRunMessage(sessionId: string, text: string): boolean {
  const operation = resolveReplyRunForCurrentSessionId(sessionId);
  const backend = operation ? getAttachedBackend(operation) : undefined;
  if (!operation || operation.phase !== "running" || !backend?.queueMessage) {
    return false;
  }
  if (!backend.isStreaming()) {
    return false;
  }
  void backend.queueMessage(text);
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

export function waitForReplyRunEndBySessionId(
  sessionId: string,
  timeoutMs = 15_000,
): Promise<boolean> {
  const waitKey = resolveReplyRunWaitKey(sessionId);
  if (!waitKey) {
    return Promise.resolve(true);
  }
  return replyRunRegistry.waitForIdle(waitKey, timeoutMs);
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

/**
 * Returns the total number of successful `createReplyOperation` calls ever
 * made for this sessionKey.  Monotonic; never decremented.  Callers capture
 * the value before an await and compare it afterward to detect whether any
 * new operation was created during the wait — including ones that already
 * finished and cleared the registry.  This is the signal the interrupt-mode
 * retry path in agent-runner uses to refuse superseding a slot that a newer
 * request already owned and released.
 */
export function readReplyRunCreateSeq(sessionKey: string): number {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  if (!normalizedSessionKey) {
    return 0;
  }
  return replyRunState.createSeqByKey.get(normalizedSessionKey) ?? 0;
}

export const __testing = {
  resetReplyRunRegistry(): void {
    replyRunState.activeRunsByKey.clear();
    replyRunState.activeSessionIdsByKey.clear();
    replyRunState.activeKeysBySessionId.clear();
    replyRunState.waitKeysBySessionId.clear();
    for (const waiters of replyRunState.waitersByKey.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(false);
      }
    }
    replyRunState.waitersByKey.clear();
    replyRunState.createSeqByKey.clear();
  },
};
