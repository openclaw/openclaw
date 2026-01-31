type FetchWithPreconnect = typeof fetch & {
  preconnect: (url: string, init?: { credentials?: RequestCredentials }) => void;
};

type RequestInitWithDuplex = RequestInit & { duplex?: "half" };

function sanitizeHeaderValue(value: string): string {
  // fast path for common ascii
  let isClean = true;
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 255) {
      isClean = false;
      break;
    }
  }
  if (isClean) {
    return value;
  } // eslint-disable-line no-control-regex

  // Node's undici fetch crashes on header values > 255 (ByteString).
  // We sanitize them by replacing non-latin1 chars with '?'.
  return value.replace(/[^\u0000-\u00ff]/g, "?"); // eslint-disable-line no-control-regex
}

function sanitizeHeaders(init?: RequestInit): RequestInit | undefined {
  if (!init || !init.headers) {
    return init;
  }

  if (typeof Headers !== "undefined" && init.headers instanceof Headers) {
    // Headers object: iterate
    const dirtyEntries: [string, string][] = [];
    init.headers.forEach((value, key) => {
      const sanitized = sanitizeHeaderValue(value);
      if (sanitized !== value) {
        dirtyEntries.push([key, sanitized]);
      }
    });

    if (dirtyEntries.length > 0) {
      const h = new Headers(init.headers);
      for (const [k, v] of dirtyEntries) {
        h.set(k, v);
      }
      return { ...init, headers: h };
    }
    return init; // No changes
  }

  if (Array.isArray(init.headers)) {
    // Array of tuples
    const dirtyIndices: [number, string][] = [];
    for (let i = 0; i < init.headers.length; i++) {
      const entry = init.headers[i];
      if (entry.length >= 2) {
        const val = entry[1];
        const sanitized = sanitizeHeaderValue(val);
        if (sanitized !== val) {
          dirtyIndices.push([i, sanitized]);
        }
      }
    }
    if (dirtyIndices.length > 0) {
      const next = [...init.headers];
      for (const [i, v] of dirtyIndices) {
        next[i] = [next[i][0], v];
      }
      return { ...init, headers: next };
    }
    return init;
  }

  // Record<string, string>
  const rec = init.headers as Record<string, string>;
  let nextRec: Record<string, string> | undefined;

  for (const k in rec) {
    const v = rec[k];
    if (typeof v === "string") {
      const s = sanitizeHeaderValue(v);
      if (s !== v) {
        if (!nextRec) {
          nextRec = { ...rec };
        }
        nextRec[k] = s;
      }
    }
  }

  if (nextRec) {
    return { ...init, headers: nextRec };
  }

  return init;
}

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

export function wrapFetchWithAbortSignal(fetchImpl: typeof fetch): typeof fetch {
  const wrapped = ((input: RequestInfo | URL, init?: RequestInit) => {
    const sanitizedInit = sanitizeHeaders(init);
    const patchedInit = withDuplex(sanitizedInit, input);
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
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const response = fetchImpl(input, { ...patchedInit, signal: controller.signal });
    if (typeof signal.removeEventListener === "function") {
      void response.finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
    }
    return response;
  }) as FetchWithPreconnect;

  const fetchWithPreconnect = fetchImpl as FetchWithPreconnect;
  wrapped.preconnect =
    typeof fetchWithPreconnect.preconnect === "function"
      ? fetchWithPreconnect.preconnect.bind(fetchWithPreconnect)
      : () => {};

  return Object.assign(wrapped, fetchImpl);
}

export function resolveFetch(fetchImpl?: typeof fetch): typeof fetch | undefined {
  const resolved = fetchImpl ?? globalThis.fetch;
  if (!resolved) {
    return undefined;
  }
  return wrapFetchWithAbortSignal(resolved);
}

export function installGlobalFetchSanitizer(): void {
  if (globalThis.fetch) {
    globalThis.fetch = wrapFetchWithAbortSignal(globalThis.fetch);
  }
}
