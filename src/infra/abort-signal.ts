export { createAbortError, racePromiseWithAbortSignal } from "../../packages/retry/src/index.js";

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  try {
    const name = "name" in error ? String(error.name) : "";
    if (name === "AbortError") {
      return true;
    }
    const message = "message" in error && typeof error.message === "string" ? error.message : "";
    return message === "This operation was aborted";
  } catch {
    return false;
  }
}

/**
 * Resolves when the signal aborts, or immediately when no wait is needed.
 *
 * A caller that can stop waiting before the signal aborts - typically
 * `Promise.race` against another source - must call `release` afterwards so the
 * abandoned wait does not hold an `abort` listener on a long-lived signal.
 */
export function waitForAbortSignal(signal?: AbortSignal): Promise<void> & { release: () => void } {
  if (!signal || signal.aborted) {
    return Object.assign(Promise.resolve(), { release: () => {} });
  }
  let onAbort!: () => void;
  const wait = new Promise<void>((resolve) => {
    let settled = false;
    onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
  return Object.assign(wait, { release: () => signal.removeEventListener("abort", onAbort) });
}
/**
 * Races a source against an abort wait without leaking the wait's listener.
 *
 * Unlike `racePromiseWithAbortSignal`, an abort resolves rather than rejects, so
 * callers that treat "the signal fired" as a successful early return keep that
 * behavior. The wait's listener is released once the race settles either way.
 */
export async function raceWithAbortRelease<T>(
  source: Promise<T>,
  signal?: AbortSignal,
): Promise<T | undefined> {
  const aborted = waitForAbortSignal(signal);
  try {
    return await Promise.race([source, aborted.then(() => undefined)]);
  } finally {
    aborted.release();
  }
}
