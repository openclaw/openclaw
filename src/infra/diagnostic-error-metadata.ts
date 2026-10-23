import { sha256HexPrefixCore } from "./crypto-digest.js";

const HTTP_STATUS_MIN = 100;
const HTTP_STATUS_MAX = 599;
const REQUEST_ID_HASH_PREFIX_LEN = 12;
const PROVIDER_REQUEST_ID_KEYS = [
  "upstreamRequestId",
  "providerRequestId",
  "requestId",
  "request_id",
] as const;
const PROVIDER_REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/u;
const PROVIDER_REQUEST_ID_TEXT_PATTERN =
  /\b(?:x-request-id|request-id|request_id|requestId|trace-id|trace_id)\b["'\s:=([]+([A-Za-z0-9._:-]{1,128})/i;

type DiagnosticErrorFailureKind =
  | "aborted"
  | "connection_closed"
  | "connection_reset"
  | "terminated"
  | "timeout";

const FAILURE_KIND_BY_CODE = new Map<string, DiagnosticErrorFailureKind>([
  ["ABORT_ERR", "aborted"],
  ["ECONNABORTED", "aborted"],
  ["ERR_ABORTED", "aborted"],
  ["ECONNRESET", "connection_reset"],
  ["ERR_STREAM_PREMATURE_CLOSE", "connection_closed"],
  ["UND_ERR_SOCKET", "connection_closed"],
  ["ETIMEDOUT", "timeout"],
  ["ERR_SOCKET_CONNECTION_TIMEOUT", "timeout"],
]);
const FAILURE_KIND_BY_MESSAGE: ReadonlyArray<readonly [RegExp, DiagnosticErrorFailureKind]> = [
  [/\b(?:terminated|sigkill|sigterm)\b/i, "terminated"],
  [/\b(?:econnreset|connection reset)\b/i, "connection_reset"],
  [
    /\b(?:socket hang up|premature close|connection closed|other side closed)\b/i,
    "connection_closed",
  ],
  [/\b(?:timed out|timeout|etimedout)\b/i, "timeout"],
  [/\b(?:aborted|abort_err|operation was aborted)\b/i, "aborted"],
];

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}

function readOwnDataProperty(value: unknown, key: string): unknown {
  if (!isObjectLike(value)) {
    return undefined;
  }
  try {
    // Read only own data properties; diagnostic extraction must not trigger userland getters.
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function findDiagnosticErrorProperty<T>(
  err: unknown,
  reader: (candidate: unknown) => T | undefined,
  seen: Set<object> = new Set(),
): T | undefined {
  const direct = reader(err);
  if (direct !== undefined) {
    return direct;
  }
  if (!isObjectLike(err) || seen.has(err)) {
    return undefined;
  }
  seen.add(err);
  return (
    findDiagnosticErrorProperty(readOwnDataProperty(err, "error"), reader, seen) ??
    findDiagnosticErrorProperty(readOwnDataProperty(err, "cause"), reader, seen)
  );
}

function isHttpStatusCode(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= HTTP_STATUS_MIN &&
    value <= HTTP_STATUS_MAX
  );
}

function normalizeProviderRequestId(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return PROVIDER_REQUEST_ID_RE.test(trimmed) ? trimmed : undefined;
  }
  if ((typeof value === "number" && Number.isFinite(value)) || typeof value === "bigint") {
    const normalized = String(value);
    return PROVIDER_REQUEST_ID_RE.test(normalized) ? normalized : undefined;
  }
  return undefined;
}

function readDirectProviderRequestId(err: unknown): string | undefined {
  for (const key of PROVIDER_REQUEST_ID_KEYS) {
    const normalized = normalizeProviderRequestId(readOwnDataProperty(err, key));
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function readDirectMessage(err: unknown): string | undefined {
  if (typeof err === "string") {
    return err;
  }
  const message = readOwnDataProperty(err, "message");
  return typeof message === "string" ? message : undefined;
}

function readDirectCode(err: unknown): string | undefined {
  const code = readOwnDataProperty(err, "code");
  return typeof code === "string" ? code : undefined;
}

function extractProviderRequestIdFromText(text: string | undefined): string | undefined {
  return normalizeProviderRequestId(text?.match(PROVIDER_REQUEST_ID_TEXT_PATTERN)?.[1]);
}

/** Returns a low-cardinality error category without trusting mutable `Error.name`. */
export function diagnosticErrorCategory(err: unknown): string {
  try {
    if (err instanceof TypeError) {
      return "TypeError";
    }
    if (err instanceof RangeError) {
      return "RangeError";
    }
    if (err instanceof ReferenceError) {
      return "ReferenceError";
    }
    if (err instanceof SyntaxError) {
      return "SyntaxError";
    }
    if (err instanceof URIError) {
      return "URIError";
    }
    if (typeof AggregateError !== "undefined" && err instanceof AggregateError) {
      return "AggregateError";
    }
    if (err instanceof Error) {
      return "Error";
    }
  } catch {
    return "unknown";
  }
  if (err === null) {
    return "null";
  }
  return typeof err;
}

/** Reads only an own data property so diagnostics never invoke a user-defined getter. */
export function diagnosticErrorMessage(err: unknown): string | undefined {
  return readDirectMessage(err)?.trim() || undefined;
}

/** Extracts a safe HTTP status code from own `status` or `statusCode` data properties. */
export function diagnosticHttpStatusCode(err: unknown): string | undefined {
  for (const key of ["status", "statusCode"]) {
    const status = readOwnDataProperty(err, key);
    if (isHttpStatusCode(status)) {
      return String(status);
    }
  }
  return undefined;
}

/** Classifies transport-style failures without exposing raw error messages. */
export function diagnosticErrorFailureKind(err: unknown): DiagnosticErrorFailureKind | undefined {
  const code = findDiagnosticErrorProperty(err, readDirectCode)?.trim().toUpperCase();
  const kind = code === undefined ? undefined : FAILURE_KIND_BY_CODE.get(code);
  if (kind) {
    return kind;
  }

  const message = findDiagnosticErrorProperty(err, readDirectMessage);
  if (!message) {
    return undefined;
  }
  return FAILURE_KIND_BY_MESSAGE.find(([pattern]) => pattern.test(message))?.[1];
}

/** Extracts and hashes bounded provider request ids so diagnostics never expose raw ids. */
export function diagnosticProviderRequestIdHash(err: unknown): string | undefined {
  const requestId =
    findDiagnosticErrorProperty(err, readDirectProviderRequestId) ??
    findDiagnosticErrorProperty(err, (candidate) =>
      extractProviderRequestIdFromText(readDirectMessage(candidate)),
    );
  return requestId
    ? `sha256:${sha256HexPrefixCore(requestId, REQUEST_ID_HASH_PREFIX_LEN)}`
    : undefined;
}
