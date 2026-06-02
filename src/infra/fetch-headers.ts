type HeadersLike = {
  entries: () => IterableIterator<[string, string]>;
  get: (name: string) => string | null;
  [Symbol.iterator]: () => IterableIterator<[string, string]>;
};

function isHeadersLike(value: object): value is HeadersLike {
  if (typeof Headers !== "undefined" && value instanceof Headers) {
    return true;
  }
  const candidate = value as Partial<HeadersLike>;
  return (
    typeof candidate.entries === "function" &&
    typeof candidate.get === "function" &&
    typeof candidate[Symbol.iterator] === "function"
  );
}

/** Normalize plain header records before passing them to runtime fetch implementations. */
export function normalizeHeadersInitForFetch(
  headers: HeadersInit | undefined,
): HeadersInit | undefined {
  // Some runtimes reject symbol-keyed header records, so preserve strings and drop symbols.
  if (!headers || typeof headers !== "object" || Array.isArray(headers) || isHeadersLike(headers)) {
    return headers;
  }
  if (Object.getOwnPropertySymbols(headers).length === 0) {
    return headers;
  }

  const normalized = Object.create(null) as Record<string, string>;
  const headerRecord = headers as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(headerRecord)) {
    normalized[key] = String(headerRecord[key]);
  }
  return normalized;
}

/** Clone RequestInit only when its headers need fetch-runtime normalization. */
export function normalizeRequestInitHeadersForFetch<T extends { headers?: HeadersInit }>(
  init: T | undefined,
): T | undefined {
  if (!init?.headers) {
    return init;
  }
  const headers = normalizeHeadersInitForFetch(init.headers);
  if (headers === init.headers) {
    return init;
  }
  return { ...init, headers } as T;
}
