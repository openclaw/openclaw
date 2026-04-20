// Supported cancel fan-out seam between delegated tasks (often plugin-owned)
// and the OpenClaw run that owns them.
//
// Two directions converge on the same shape:
//   { kind: "session_run", sessionKey, runId }
//
//   1. Plugin -> core: delegated-task code calls `requestSessionRunCancel` to
//      ask core to abort the owning OpenClaw run. Core registers the concrete
//      abort behavior through `setSessionRunAbortRequester`.
//   2. Core -> plugin: core calls `emitSessionRunCancel` when it aborts a run,
//      which notifies any delegated-task cancel handlers registered via
//      `onSessionRunCancel`.
//
// The seam is intentionally plugin-neutral: core call sites must not branch on
// specific plugins or transports (for example A2A). Plugins opt in by calling
// the exported helpers.

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

let abortRequester: SessionRunAbortRequester | undefined;

function keyFor(target: SessionRunCancelTarget): HandlerKey {
  return `${target.sessionKey}\u0000${target.runId}`;
}

export function onSessionRunCancel(
  target: SessionRunCancelTarget,
  handler: SessionRunCancelHandler,
): () => void {
  const key = keyFor(target);
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

export function emitSessionRunCancel(
  target: SessionRunCancelTarget,
  reason?: SessionRunCancelReason,
): { handlerCount: number } {
  const key = keyFor(target);
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
    abortRequester = undefined;
  },
  handlerCount(target: SessionRunCancelTarget): number {
    return HANDLERS.get(keyFor(target))?.size ?? 0;
  },
};
