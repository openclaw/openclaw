import { bindAbortRelay } from "../utils/fetch-timeout.js";
import { normalizeRequestInitHeadersForFetch } from "./fetch-headers.js";

type FetchWithPreconnect = typeof fetch & {
  preconnect: (url: string, init?: { credentials?: RequestCredentials }) => void;
};

type RequestInitWithDuplex = RequestInit & { duplex?: "half" };

const wrapFetchWithAbortSignalMarker = Symbol.for("openclaw.fetch.abort-signal-wrapped");

type FetchWithAbortSignalMarker = typeof fetch & {
  [wrapFetchWithAbortSignalMarker]?: true;
};

// Node/undici requires `duplex: "half"` for streaming request bodies, while
// browser fetch ignores it. Add it only when a body exists to preserve GET shape.
function withDuplex(
  init: RequestInit | undefined,
  input: RequestInfo | URL,
): RequestInit | undefined {
  const hasInitBody = init?.body != null;
  const hasRequestBody =
    !hasInitBody &&
    typeof Request !== "undefined" &&
    input instanceof Request &&
    input.body != null;
  if (!hasInitBody && !hasRequestBody) {
    return init;
  }
  if (init && "duplex" in (init as Record<string, unknown>)) {
    return init;
  }
  return init
    ? ({ ...init, duplex: "half" as const } as RequestInitWithDuplex)
    : ({ duplex: "half" as const } as RequestInitWithDuplex);
}

/**
 * Wrap a fetch implementation so SDK/plugin callers can pass foreign
 * AbortSignal-like objects while preserving native signals, undici duplex
 * requirements, normalized headers, and `preconnect`.
 */
export function wrapFetchWithAbortSignal(fetchImpl: typeof fetch): typeof fetch {
  if ((fetchImpl as FetchWithAbortSignalMarker)[wrapFetchWithAbortSignalMarker]) {
    return fetchImpl;
  }

  const wrapped = ((input: RequestInfo | URL, init?: RequestInit) => {
    const patchedInit = normalizeRequestInitHeadersForFetch(withDuplex(init, input));
    const signal = patchedInit?.signal;
    if (!signal) {
      return fetchImpl(input, patchedInit);
    }
    if (typeof AbortSignal !== "undefined" && signal instanceof AbortSignal) {
      return fetchImpl(input, patchedInit);
    }
    if (typeof AbortController === "undefined") {
      return fetchImpl(input, patchedInit);
    }
    if (typeof signal.addEventListener !== "function") {
      return fetchImpl(input, patchedInit);
    }
    // Some runtime boundaries hand us signal-like objects from another realm.
    // Relay them through a native controller so undici accepts the request.
    const controller = new AbortController();
    const onAbort = bindAbortRelay(controller);
    let listenerAttached = false;
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
      listenerAttached = true;
    }
    const cleanup = () => {
      if (!listenerAttached || typeof signal.removeEventListener !== "function") {
        return;
      }
      listenerAttached = false;
      try {
        signal.removeEventListener("abort", onAbort);
      } catch {
        // Foreign/custom AbortSignal implementations may throw here.
        // Never let cleanup mask the original fetch result/error.
      }
    };
    try {
      const response = fetchImpl(input, { ...patchedInit, signal: controller.signal });
      return response.finally(cleanup);
    } catch (error) {
      cleanup();
      throw error;
    }
  }) as FetchWithPreconnect;

  const wrappedFetch = Object.assign(wrapped, fetchImpl) as FetchWithPreconnect;
  const fetchWithPreconnect = fetchImpl as FetchWithPreconnect;
  // Preserve React/undici-style preconnect helpers for SDK callers that receive
  // this wrapped fetch instead of the original implementation.
  wrappedFetch.preconnect =
    typeof fetchWithPreconnect.preconnect === "function"
      ? fetchWithPreconnect.preconnect.bind(fetchWithPreconnect)
      : () => {};

  Object.defineProperty(wrappedFetch, wrapFetchWithAbortSignalMarker, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return wrappedFetch;
}

/** Resolve an explicit or global fetch implementation and apply OpenClaw compatibility wrapping. */
export function resolveFetch(fetchImpl?: typeof fetch): typeof fetch | undefined {
  const resolved = fetchImpl ?? globalThis.fetch;
  if (!resolved) {
    return undefined;
  }
  return wrapFetchWithAbortSignal(resolved);
}
