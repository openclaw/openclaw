/**
 * Relay abort without forwarding the Event argument as the abort reason.
 * Using .bind() avoids closure scope capture (memory leak prevention).
 */
function relayAbort() {
    this.abort();
}
/** Returns a bound abort relay for use as an event listener. */
export function bindAbortRelay(controller) {
    return relayAbort.bind(controller);
}
export function buildTimeoutAbortSignal(params) {
    const { timeoutMs, signal } = params;
    if (!timeoutMs && !signal) {
        return { signal: undefined, cleanup: () => { } };
    }
    if (!timeoutMs) {
        return { signal, cleanup: () => { } };
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(controller.abort.bind(controller), timeoutMs);
    const onAbort = bindAbortRelay(controller);
    if (signal) {
        if (signal.aborted) {
            controller.abort();
        }
        else {
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
export async function fetchWithTimeout(url, init, timeoutMs, fetchFn = fetch) {
    const { signal, cleanup } = buildTimeoutAbortSignal({
        timeoutMs: Math.max(1, timeoutMs),
    });
    try {
        return await fetchFn(url, { ...init, signal });
    }
    finally {
        cleanup();
    }
}
