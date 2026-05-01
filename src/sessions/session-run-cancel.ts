// Supported cancel fan-out seam between delegated tasks (often plugin-owned)
// and the OpenClaw run that owns them.
//
// Two directions converge on the same shape:
//   { kind: "session_run", sessionKey, runId }
//
//   1. Plugin -> core: delegated-task code calls `requestSessionRunCancel` to
//      ask core to abort the owning OpenClaw run. Core registers the concrete
//      abort behavior through `setSessionRunAbortRequester`.
//   2. Core -> plugin: core calls `emitSessionRunCancel` (core-internal) when it
//      aborts a run, which notifies any delegated-task cancel handlers registered
//      via `onSessionRunCancel`.
//
// The seam is intentionally plugin-neutral: core call sites must not branch on
// specific plugins or transports (for example A2A). Plugins opt in by calling
// the exported helpers.
//
// Sticky cancellation: if core aborts before a handler registers,
// `onSessionRunCancel` replays the terminal cancel to the late subscriber.
// The terminal state lives until explicit cleanup (clearSessionRunCancelTarget
// or __testing.reset).

export type SessionRunCancelTarget = {
  kind: "session_run";
  sessionKey: string;
  runId: string;
};

export type SessionRunCancelReason = {
  source: string;
  message?: string;
};

export type SessionRunCancelHandler = (
  target: SessionRunCancelTarget,
  reason?: SessionRunCancelReason,
) => void | Promise<void>;

export type SessionRunAbortRequester = (
  target: SessionRunCancelTarget,
  reason?: SessionRunCancelReason,
) => boolean | Promise<boolean>;

export type RequestSessionRunCancelResult = {
  requested: boolean;
  aborted: boolean;
};

type HandlerKey = `${string}\u0000${string}`;

const HANDLERS = new Map<HandlerKey, Set<SessionRunCancelHandler>>();

// Terminal cancel state for sticky replay: when core aborts before handler
// registration, the target+reason are stored here and replayed to any later
// onSessionRunCancel subscriber.  This ensures plugin-owned delegated tasks
// registered after an abort can still observe the cancellation deterministically.
const TERMINAL_CANCELS = new Map<HandlerKey, SessionRunCancelReason | undefined>();

let abortRequester: SessionRunAbortRequester | undefined;

function keyFor(target: SessionRunCancelTarget): HandlerKey {
  return `${target.sessionKey}\u0000${target.runId}`;
}

export function onSessionRunCancel(
  target: SessionRunCancelTarget,
  handler: SessionRunCancelHandler,
): () => void {
  const key = keyFor(target);

  // Sticky replay: if this target has already been cancelled before the
  // handler registered, invoke it immediately with the stored reason.
  if (TERMINAL_CANCELS.has(key)) {
    const terminalReason = TERMINAL_CANCELS.get(key);
    try {
      const result = handler(target, terminalReason);
      if (result && typeof (result as Promise<unknown>).then === "function") {
        (result as Promise<unknown>).catch(() => {
          // Best-effort replay; swallow async handler errors.
        });
      }
    } catch {
      // Best-effort replay; swallow sync handler errors.
    }
    // The cancel is already terminal — handler has been notified.
    // Return a no-op disposer since there is nothing to unregister from
    // the live HANDLERS map.
    return () => {};
  }

  let bucket = HANDLERS.get(key);
  if (!bucket) {
    bucket = new Set();
    HANDLERS.set(key, bucket);
  }
  bucket.add(handler);
  let disposed = false;
  return () => {
    if (disposed) {
      return;
    }
    disposed = true;
    const current = HANDLERS.get(key);
    if (!current) {
      return;
    }
    current.delete(handler);
    if (current.size === 0) {
      HANDLERS.delete(key);
    }
  };
}

// emitSessionRunCancel is core-internal.  Plugin code must not import it; use
// onSessionRunCancel to observe and requestSessionRunCancel to request. Only
// core call-sites (chat-abort, server lifecycle) may emit.
export function emitSessionRunCancel(
  target: SessionRunCancelTarget,
  reason?: SessionRunCancelReason,
): { handlerCount: number } {
  const key = keyFor(target);

  // Store terminal cancel so late subscribers can observe it (sticky replay).
  // If the target was already terminal, keep the original reason — first emit
  // wins for deterministic replay.
  if (!TERMINAL_CANCELS.has(key)) {
    TERMINAL_CANCELS.set(key, reason);
  }

  const bucket = HANDLERS.get(key);
  if (!bucket || bucket.size === 0) {
    return { handlerCount: 0 };
  }
  // Snapshot so handlers can unregister during dispatch without affecting the
  // remaining fan-out, and clear eagerly so duplicate emits are idempotent.
  const snapshot = Array.from(bucket);
  HANDLERS.delete(key);
  for (const handler of snapshot) {
    try {
      const result = handler(target, reason);
      if (result && typeof (result as Promise<unknown>).then === "function") {
        (result as Promise<unknown>).catch(() => {
          // Best-effort fan-out; swallow async handler errors.
        });
      }
    } catch {
      // Best-effort fan-out; swallow sync handler errors.
    }
  }
  return { handlerCount: snapshot.length };
}

// Clears the terminal cancel state for a specific target.  After this call,
// new onSessionRunCancel subscribers for the same target will go through
// normal handler registration instead of sticky replay.  Call this when the
// session-run lifecycle is fully cleaned up (e.g. run teardown, session close).
export function clearSessionRunCancelTarget(target: SessionRunCancelTarget): void {
  TERMINAL_CANCELS.delete(keyFor(target));
}

export function setSessionRunAbortRequester(
  requester: SessionRunAbortRequester | undefined,
): () => void {
  abortRequester = requester;
  return () => {
    if (abortRequester === requester) {
      abortRequester = undefined;
    }
  };
}

export async function requestSessionRunCancel(
  target: SessionRunCancelTarget,
  reason?: SessionRunCancelReason,
): Promise<RequestSessionRunCancelResult> {
  const requester = abortRequester;
  if (!requester) {
    return { requested: false, aborted: false };
  }
  try {
    const aborted = await requester(target, reason);
    return { requested: true, aborted: aborted };
  } catch {
    return { requested: true, aborted: false };
  }
}

export const __testing = {
  reset(): void {
    HANDLERS.clear();
    TERMINAL_CANCELS.clear();
    abortRequester = undefined;
  },
  handlerCount(target: SessionRunCancelTarget): number {
    return HANDLERS.get(keyFor(target))?.size ?? 0;
  },
  terminalCancelCount(): number {
    return TERMINAL_CANCELS.size;
  },
  hasTerminalCancel(target: SessionRunCancelTarget): boolean {
    return TERMINAL_CANCELS.has(keyFor(target));
  },
};
