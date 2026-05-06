type HeadersLike = {
  entries: () => IterableIterator<[string, string]>;
  get: (name: string) => string | null;
  [Symbol.iterator]: () => IterableIterator<[string, string]>;
};

type HeadersInput =
  | HeadersInit
  | null
  | undefined
  | readonly unknown[]
  | Record<string, unknown>
  | { rawHeaders?: unknown };

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

function stringifyHeaderValue(value: unknown): string {
  return String(value);
}

function stringifyHeaderName(name: unknown): string | null {
  switch (typeof name) {
    case "string":
      return name.trim();
    case "number":
    case "boolean":
    case "bigint":
      return String(name).trim();
    default:
      return null;
  }
}

function appendHeader(headers: Headers, name: unknown, value: unknown) {
  const key = stringifyHeaderName(name);
  if (!key) {
    return;
  }
  headers.append(key, stringifyHeaderValue(value));
}

function normalizeTupleHeaders(headers: readonly unknown[]): HeadersInit {
  const needsNormalization = headers.some(
    (entry) =>
      !Array.isArray(entry) ||
      entry.length < 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string",
  );
  if (!needsNormalization) {
    return headers as HeadersInit;
  }
  const normalized = new Headers();
  for (const entry of headers) {
    if (!Array.isArray(entry) || entry.length < 2) {
      continue;
    }
    appendHeader(normalized, entry[0], entry[1]);
  }
  return normalized;
}

function normalizeFlatRawHeaders(headers: readonly unknown[]): HeadersInit {
  const normalized = new Headers();
  for (let index = 0; index < headers.length - 1; index += 2) {
    appendHeader(normalized, headers[index], headers[index + 1]);
  }
  return normalized;
}

function normalizeArrayHeaders(headers: readonly unknown[]): HeadersInit {
  if (headers.every(Array.isArray)) {
    return normalizeTupleHeaders(headers);
  }
  return normalizeFlatRawHeaders(headers);
}

function normalizePlainHeaderRecord(headers: object): HeadersInit {
  const ownNames = Object.getOwnPropertyNames(headers);
  const hasSymbols = Object.getOwnPropertySymbols(headers).length > 0;
  const headerRecord = headers as Record<string, unknown>;
  const hasNonStringValues = ownNames.some((key) => typeof headerRecord[key] !== "string");
  if (!hasSymbols && !hasNonStringValues) {
    return headers as HeadersInit;
  }

  const normalized = Object.create(null) as Record<string, string>;
  for (const key of ownNames) {
    normalized[key] = stringifyHeaderValue(headerRecord[key]);
  }
  return normalized;
}

export function normalizeHeadersInitForFetch(headers: HeadersInput): HeadersInit | undefined {
  if (!headers) {
    return undefined;
  }
  if (typeof headers !== "object") {
    return headers as HeadersInit;
  }
  if (isHeadersLike(headers)) {
    return headers as HeadersInit;
  }
  if (Array.isArray(headers)) {
    return normalizeArrayHeaders(headers);
  }

  const rawHeaders = (headers as { rawHeaders?: unknown }).rawHeaders;
  if (Array.isArray(rawHeaders)) {
    return normalizeFlatRawHeaders(rawHeaders);
  }

  return normalizePlainHeaderRecord(headers);
}

export function normalizeRequestInitHeadersForFetch<T extends { headers?: HeadersInput }>(
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
