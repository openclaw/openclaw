import { redactSensitiveText, resolveRedactOptions, type ResolvedRedactOptions } from "./redact.js";

const CIRCULAR_SENTINEL = "[Circular]";
const TRUNCATED_SENTINEL = "[Truncated]";
const MAX_REDACTION_DEPTH = 8;
const DIRECT_SECRET_MIN_LENGTH = 18;
const DIRECT_SECRET_KEEP_START = 6;
const DIRECT_SECRET_KEEP_END = 4;
const NON_CREDENTIAL_FIELD_NAMES = new Set([
  "passwordfile",
  "tokenbudget",
  "tokencount",
  "tokenfield",
  "tokenlimit",
  "tokens",
]);

type JsonLikeRecord = Record<string, unknown>;

function shouldBypassRedaction(resolved: ResolvedRedactOptions): boolean {
  return resolved.mode === "off" || resolved.patterns.length === 0;
}

function normalizeFieldName(value: string): string {
  return value.replaceAll(/[^a-z0-9]/gi, "").toLowerCase();
}

function isCredentialFieldName(key: string): boolean {
  const normalized = normalizeFieldName(key);
  if (!normalized || NON_CREDENTIAL_FIELD_NAMES.has(normalized)) {
    return false;
  }
  if (normalized === "authorization" || normalized === "proxyauthorization") {
    return true;
  }
  return (
    normalized.endsWith("apikey") ||
    normalized.endsWith("password") ||
    normalized.endsWith("passwd") ||
    normalized.endsWith("passphrase") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("secretkey") ||
    normalized.endsWith("token")
  );
}

function maskDirectSecret(value: string): string {
  if (value.length < DIRECT_SECRET_MIN_LENGTH) {
    return "***";
  }
  const start = value.slice(0, DIRECT_SECRET_KEEP_START);
  const end = value.slice(-DIRECT_SECRET_KEEP_END);
  return `${start}…${end}`;
}

function shouldMaskDirectString(value: string): boolean {
  return /^[A-Za-z0-9._:+\-=]{18,}$/.test(value);
}

export function sanitizeStringForSink(
  text: string,
  resolved: ResolvedRedactOptions = resolveRedactOptions(),
): string {
  if (!text || shouldBypassRedaction(resolved)) {
    return text;
  }
  try {
    const redacted = redactSensitiveText(text, resolved);
    if (redacted !== text) {
      return redacted;
    }
    return shouldMaskDirectString(text) ? maskDirectSecret(text) : text;
  } catch {
    return text;
  }
}

function sanitizeFieldValueForSink(
  key: string,
  value: unknown,
  resolved: ResolvedRedactOptions,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (typeof value === "string" && isCredentialFieldName(key)) {
    const textSanitized = sanitizeStringForSink(value, resolved);
    return textSanitized === value ? maskDirectSecret(value) : textSanitized;
  }
  return sanitizeValueForSink(value, resolved, seen, depth + 1);
}

function sanitizeErrorForSink(
  error: Error,
  resolved: ResolvedRedactOptions,
  seen: WeakSet<object>,
  depth: number,
): JsonLikeRecord | string {
  if (seen.has(error)) {
    return CIRCULAR_SENTINEL;
  }
  seen.add(error);
  try {
    const out: JsonLikeRecord = {
      name: sanitizeStringForSink(error.name, resolved),
      message: sanitizeStringForSink(error.message, resolved),
    };
    if (typeof error.stack === "string") {
      out.stack = sanitizeStringForSink(error.stack, resolved);
    }
    const errorWithCause = error as Error & { cause?: unknown };
    if ("cause" in errorWithCause && errorWithCause.cause !== undefined) {
      out.cause = sanitizeValueForSink(errorWithCause.cause, resolved, seen, depth + 1);
    }
    for (const [key, value] of Object.entries(error as unknown as JsonLikeRecord)) {
      out[key] = sanitizeFieldValueForSink(key, value, resolved, seen, depth);
    }
    return out;
  } finally {
    seen.delete(error);
  }
}

function sanitizeRecordForSink(
  record: JsonLikeRecord,
  resolved: ResolvedRedactOptions,
  seen: WeakSet<object>,
  depth: number,
): JsonLikeRecord | string {
  if (seen.has(record)) {
    return CIRCULAR_SENTINEL;
  }
  seen.add(record);
  try {
    const out: JsonLikeRecord = {};
    for (const [key, value] of Object.entries(record)) {
      out[key] = sanitizeFieldValueForSink(key, value, resolved, seen, depth);
    }
    return out;
  } finally {
    seen.delete(record);
  }
}

function sanitizeValueForSink(
  value: unknown,
  resolved: ResolvedRedactOptions,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (typeof value === "string") {
    return sanitizeStringForSink(value, resolved);
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  if (depth >= MAX_REDACTION_DEPTH) {
    return TRUNCATED_SENTINEL;
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (value instanceof Error) {
    return sanitizeErrorForSink(value, resolved, seen, depth);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValueForSink(entry, resolved, seen, depth + 1));
  }
  if (typeof value === "object") {
    return sanitizeRecordForSink(value as JsonLikeRecord, resolved, seen, depth);
  }
  return value;
}

export function sanitizeLogRecordForSink<T extends JsonLikeRecord>(
  record: T,
  resolved: ResolvedRedactOptions = resolveRedactOptions(),
): T {
  if (shouldBypassRedaction(resolved)) {
    return record;
  }
  try {
    return sanitizeValueForSink(record, resolved, new WeakSet<object>(), 0) as T;
  } catch {
    return record;
  }
}
