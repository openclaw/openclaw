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
// specific plugins or transports (for example A2A). Plugins opt in via the
// public plugin-sdk/session-run-cancel-runtime subpath, which deliberately does
// not export the core emitter.
//
// Sticky cancellation: if core aborts before a handler registers,
// `onSessionRunCancel` replays the terminal cancel to the late subscriber.
// The terminal state is intentionally bounded: production run teardown should
// clear it with `clearSessionRunCancelTarget`, and the module also prunes old
// entries by TTL/max-size as a safety net for missed cleanup paths.

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
const TERMINAL_CANCEL_TTL_MS = 10 * 60_000;
const TERMINAL_CANCEL_MAX_ENTRIES = 1_000;
const TERMINAL_CANCELS = new Map<
  HandlerKey,
  { reason: SessionRunCancelReason | undefined; recordedAtMs: number }
>();

let abortRequester: SessionRunAbortRequester | undefined;

function keyFor(target: SessionRunCancelTarget): HandlerKey {
  return `${target.sessionKey}\u0000${target.runId}`;
}

function pruneTerminalCancels(now = Date.now()): void {
  for (const [key, entry] of TERMINAL_CANCELS) {
    if (now - entry.recordedAtMs > TERMINAL_CANCEL_TTL_MS) {
      TERMINAL_CANCELS.delete(key);
    }
  }

  const excess = TERMINAL_CANCELS.size - TERMINAL_CANCEL_MAX_ENTRIES;
  if (excess <= 0) {
    return;
  }
  let removed = 0;
  for (const key of TERMINAL_CANCELS.keys()) {
    TERMINAL_CANCELS.delete(key);
    removed += 1;
    if (removed >= excess) {
      break;
    }
  }
}

function invokeBestEffort(
  handler: SessionRunCancelHandler,
  target: SessionRunCancelTarget,
  reason?: SessionRunCancelReason,
): void {
  try {
    const result = handler(target, reason);
    if (result && typeof (result as Promise<unknown>).then === "function") {
      (result as Promise<unknown>).catch(() => {
        // Best-effort fan-out/replay; swallow async handler errors.
      });
    }
  } catch {
    // Best-effort fan-out/replay; swallow sync handler errors.
  }
}

export function onSessionRunCancel(
  target: SessionRunCancelTarget,
  handler: SessionRunCancelHandler,
): () => void {
  const key = keyFor(target);
  pruneTerminalCancels();

  const terminalCancel = TERMINAL_CANCELS.get(key);
  if (terminalCancel) {
    invokeBestEffort(handler, target, terminalCancel.reason);
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

// Core-internal emitter. Do not expose this from plugin SDK runtime subpaths;
// plugins observe via `onSessionRunCancel` or request via
// `requestSessionRunCancel` instead.
export function emitSessionRunCancel(
  target: SessionRunCancelTarget,
  reason?: SessionRunCancelReason,
): { handlerCount: number } {
  const key = keyFor(target);
  pruneTerminalCancels();
  if (!TERMINAL_CANCELS.has(key)) {
    TERMINAL_CANCELS.set(key, { reason, recordedAtMs: Date.now() });
    pruneTerminalCancels();
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
    invokeBestEffort(handler, target, reason);
  }
  return { handlerCount: snapshot.length };
}

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
    return { requested: true, aborted };
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
    pruneTerminalCancels();
    return TERMINAL_CANCELS.size;
  },
  hasTerminalCancel(target: SessionRunCancelTarget): boolean {
    pruneTerminalCancels();
    return TERMINAL_CANCELS.has(keyFor(target));
  },
  terminalCancelMaxEntries(): number {
    return TERMINAL_CANCEL_MAX_ENTRIES;
  },
  terminalCancelTtlMs(): number {
    return TERMINAL_CANCEL_TTL_MS;
  },
};
