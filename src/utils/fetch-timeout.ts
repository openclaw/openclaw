/**
 * fetch() with a hard timeout via AbortController.
 *
 * Security note (CWE-400: Uncontrolled Resource Consumption):
 *   Without a timeout, a slow or unresponsive upstream server can hold a
 *   Node.js socket open indefinitely, exhausting the connection pool and
 *   eventually starving the process of file descriptors.
 *
 * Implementation note:
 *   We use AbortController rather than Promise.race() + withTimeout() because
 *   AbortController actually cancels the underlying TCP connection, whereas
 *   Promise.race() only stops waiting for the result — the connection would
 *   remain open in the background, leaking resources.
 *
 *   The timer fires controller.abort() which causes fetch() to reject with
 *   a DOMException named "AbortError".  The finally block always clears the
 *   timer so it cannot hold the event loop open after the request completes.
 *
 * Caller note:
 *   If `init` already contains a signal, the caller's signal is ignored.
 *   This is intentional: the timeout is the outer deadline and callers that
 *   need cooperative cancellation should compose their own AbortController
 *   with AbortSignal.any([callerSignal, controller.signal]) before passing
 *   it in.
 */

/**
 * Relay abort without forwarding the Event argument as the abort reason.
 * Using .bind() avoids closure scope capture (memory leak prevention).
 */
function relayAbort(this: AbortController) {
  this.abort();
}

/** Returns a bound abort relay for use as an event listener. */
export function bindAbortRelay(controller: AbortController): () => void {
  return relayAbort.bind(controller);
}

export function buildTimeoutAbortSignal(params: { timeoutMs?: number; signal?: AbortSignal }): {
  signal?: AbortSignal;
  cleanup: () => void;
} {
  const { timeoutMs, signal } = params;
  if (!timeoutMs && !signal) {
    return { signal: undefined, cleanup: () => {} };
  }
  if (!timeoutMs) {
    return { signal, cleanup: () => {} };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(controller.abort.bind(controller), timeoutMs);
  const onAbort = bindAbortRelay(controller);
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeoutId);
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

/**
 * Fetch wrapper that adds timeout support via AbortController.
 *
 * @param url - The URL to fetch
 * @param init - RequestInit options (headers, method, body, etc.)
 * @param timeoutMs - Timeout in milliseconds
 * @param fetchFn - The fetch implementation to use (defaults to global fetch)
 * @returns The fetch Response
 * @throws AbortError if the request times out
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  const { signal, cleanup } = buildTimeoutAbortSignal({
    timeoutMs: Math.max(1, timeoutMs),
  });
  try {
    return await fetchFn(url, { ...init, signal });
  } finally {
    cleanup();
  }
}
