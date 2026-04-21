/**
 * Sink-Level Log Sanitizer
 *
 * Pure functions that sanitize log records before they are persisted to file
 * or forwarded to transports. All functions require a pre-resolved
 * ResolvedRedactOptions — there are NO default-resolved overloads to prevent
 * callers from bypassing the shared authority (redaction-policy.ts).
 *
 * Usage:
 *   const resolved = getLoggingRedactionPolicy().resolved;
 *   const sanitized = sanitizeLogRecordForSink(record, resolved);
 */

import { redactSensitiveText, type ResolvedRedactOptions } from "./redact.js";

// ── Sentinels & limits ──────────────────────────────────────────────────────

const CIRCULAR_SENTINEL = "[Circular]";
const DEPTH_SENTINEL = "[TooDeep]";
const TRUNCATED_SENTINEL = "[TooWide]";
const EXOTIC_SENTINEL = "[Redacted:exotic]";

/** Hard cap on nesting depth to prevent DoS via deeply nested payloads (X3). */
const MAX_REDACTION_DEPTH = 16;
/** Hard cap on number of entries per record to prevent DoS via wide objects (X3). */
const MAX_REDACTION_ENTRIES = 1024;

const DIRECT_SECRET_MIN_LENGTH = 18;
const DIRECT_SECRET_KEEP_START = 6;
const DIRECT_SECRET_KEEP_END = 4;

/**
 * The set of object-prototype keys that can be abused for prototype pollution
 * or are otherwise dangerous to propagate into log output. These are filtered
 * unconditionally before building the sanitized output record (X2).
 */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// ── Types ───────────────────────────────────────────────────────────────────

type JsonLikeRecord = Record<string, unknown>;

/**
 * Explicit return type for sanitized log records. Using a named alias rather
 * than a generic `<T extends Record<…>>` avoids the false impression that
 * prototype descriptors, class methods, etc. are preserved post-sanitization (X4).
 */
export type SanitizedLogRecord = Record<string, unknown>;

/**
 * Enum-style constants for the `forceDirectMask` decision (X7).
 * Avoids mixing boolean and union-string signals inline.
 */
const enum ForceDirectMaskReason {
  None = 0,
  CredentialKey = 1,
  InheritedFromParent = 2,
  MessageOrArgKey = 3,
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function shouldBypassRedaction(resolved: ResolvedRedactOptions): boolean {
  return resolved.mode === "off" || resolved.patterns.length === 0;
}

function normalizeFieldName(value: string): string {
  return value.replaceAll(/[^a-z0-9]/gi, "").toLowerCase();
}

/**
 * Returns true for field names that conventionally carry secret values and
 * therefore warrant direct-mask fallback even when pattern redaction does not
 * match (e.g. an opaque token with unusual character set).
 */
function isCredentialFieldName(key: string): boolean {
  const normalized = normalizeFieldName(key);
  if (!normalized) {
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

/**
 * Returns true for field names that represent human-readable message positions
 * and should receive allowDirectMask promotion (C6 fix).
 * This covers `message`, `msg`, and numeric positional arg keys like `"0"`.
 */
function shouldAllowDirectStringFallback(key: string): boolean {
  return key === "message" || key === "msg" || /^\d+$/u.test(key);
}

function maskDirectSecret(value: string): string {
  if (value.length < DIRECT_SECRET_MIN_LENGTH) {
    return "***";
  }
  const start = value.slice(0, DIRECT_SECRET_KEEP_START);
  const end = value.slice(-DIRECT_SECRET_KEEP_END);
  return `${start}\u2026${end}`;
}

/**
 * Returns true when a string looks like a standalone secret token based on
 * character set and minimum length — absent any other context.
 *
 * ISO-8601 date-time strings (e.g. `"2026-04-17T10:30:00Z"`) match the
 * character-set heuristic but must NOT be masked (EC3). The prefix test
 * (`/^\d{4}-\d{2}-\d{2}T/`) is checked first and exits early so timestamps
 * continue to pass through unmodified.
 */
function shouldMaskDirectString(value: string): boolean {
  // ISO-8601 guard (EC3): exclude date-time strings from direct masking.
  if (/^\d{4}-\d{2}-\d{2}T/u.test(value)) {
    return false;
  }
  return /^[A-Za-z0-9._:+\-=]{18,}$/u.test(value);
}

// ── Core sanitize logic ──────────────────────────────────────────────────────

/**
 * Sanitize a plain string value destined for a log sink.
 *
 * @param text     The string to sanitize.
 * @param resolved Pre-resolved redaction options (required — no default).
 * @param options  Optional context; set `allowDirectMask` when the string is
 *                 under a credential-named parent key.
 */
export function sanitizeStringForSink(
  text: string,
  resolved: ResolvedRedactOptions,
  options?: { allowDirectMask?: boolean },
): string {
  if (!text || shouldBypassRedaction(resolved)) {
    return text;
  }
  try {
    const redacted = redactSensitiveText(text, resolved);
    if (redacted !== text) {
      return redacted;
    }
    return options?.allowDirectMask && shouldMaskDirectString(text) ? maskDirectSecret(text) : text;
  } catch {
    return text;
  }
}

function resolveForceDirectMaskReason(
  key: string,
  inherited?: { allowDirectMask?: boolean },
): ForceDirectMaskReason {
  if (inherited?.allowDirectMask === true) {
    return ForceDirectMaskReason.InheritedFromParent;
  }
  if (isCredentialFieldName(key)) {
    return ForceDirectMaskReason.CredentialKey;
  }
  // C6 fix: message/msg/"0" keys also get allowDirectMask promotion so that
  // toJSON objects under these keys propagate context into recursive calls.
  if (shouldAllowDirectStringFallback(key)) {
    return ForceDirectMaskReason.MessageOrArgKey;
  }
  return ForceDirectMaskReason.None;
}

function sanitizeFieldValueForSink(
  key: string,
  value: unknown,
  resolved: ResolvedRedactOptions,
  seen: WeakSet<object>,
  depth: number,
  inherited?: { allowDirectMask?: boolean; forceDoubleFallback?: boolean },
): unknown {
  const reason = resolveForceDirectMaskReason(key, inherited);
  const isCredentialContext =
    reason === ForceDirectMaskReason.CredentialKey ||
    reason === ForceDirectMaskReason.InheritedFromParent;

  if (typeof value === "string") {
    if (isCredentialContext) {
      const textSanitized = sanitizeStringForSink(value, resolved, { allowDirectMask: true });
      // Double-fallback: if pattern redaction did not touch the string, force-mask
      // it unconditionally (handles `/`-charset bypass for credential fields, C3/C4).
      // EC3 guard: never force-mask ISO-8601 timestamps even under a credential key.
      if (textSanitized === value) {
        if (/^\d{4}-\d{2}-\d{2}T/u.test(value)) {
          return value;
        }
        return maskDirectSecret(value);
      }
      return textSanitized;
    }
    // For message/msg/arg-key (C6) and non-credential keys: use sanitizeStringForSink
    // which applies the shouldMaskDirectString charset gate as a soft fallback.
    // Note: `reason === MessageOrArgKey` is already true iff shouldAllowDirectStringFallback
    // returned true inside resolveForceDirectMaskReason, so no redundant call needed.
    return sanitizeStringForSink(value, resolved, {
      allowDirectMask: reason === ForceDirectMaskReason.MessageOrArgKey,
    });
  }

  // For non-string values: propagate credential context with forceDoubleFallback so
  // that deeply nested strings (e.g. toJSON results, array entries) also get the
  // unconditional force-mask. Message/arg keys only propagate allowDirectMask (no
  // forceDoubleFallback), preserving the C6 intent: soft charset-gated masking only.
  if (isCredentialContext) {
    return sanitizeValueForSink(value, resolved, seen, depth + 1, {
      allowDirectMask: true,
      forceDoubleFallback: true,
    });
  }
  if (reason === ForceDirectMaskReason.MessageOrArgKey) {
    return sanitizeValueForSink(value, resolved, seen, depth + 1, { allowDirectMask: true });
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
    const out: JsonLikeRecord = Object.create(null) as JsonLikeRecord;
    out.name = sanitizeStringForSink(error.name, resolved);
    out.message = sanitizeStringForSink(error.message, resolved, { allowDirectMask: true });
    if (typeof error.stack === "string") {
      out.stack = sanitizeStringForSink(error.stack, resolved);
    }
    const errorWithCause = error as Error & { cause?: unknown };
    if ("cause" in errorWithCause && errorWithCause.cause !== undefined) {
      // cause is handled without carrying down allowDirectMask: credential fields
      // inside cause will be recaptured by isCredentialFieldName on the inner key.
      out.cause = sanitizeValueForSink(errorWithCause.cause, resolved, seen, depth + 1);
    }
    for (const [key, value] of Object.entries(error as unknown as JsonLikeRecord)) {
      if (DANGEROUS_KEYS.has(key)) {
        continue; // X2: filter prototype-pollution keys
      }
      try {
        out[key] = sanitizeFieldValueForSink(key, value, resolved, seen, depth);
      } catch {
        out[key] = EXOTIC_SENTINEL; // X1/X6: fail-closed on per-field access errors
      }
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
  inherited?: { allowDirectMask?: boolean; forceDoubleFallback?: boolean },
): SanitizedLogRecord | string {
  if (seen.has(record)) {
    return CIRCULAR_SENTINEL;
  }
  seen.add(record);
  try {
    // X2: Use Object.create(null) so the output has no prototype chain.
    const out: JsonLikeRecord = Object.create(null) as JsonLikeRecord;
    let entryCount = 0;
    for (const [key, value] of Object.entries(record)) {
      // X2: Hard-filter dangerous keys that could poison prototype chains.
      if (DANGEROUS_KEYS.has(key)) {
        continue;
      }
      // X3: Hard cap on record width to prevent DoS via very wide objects.
      if (entryCount >= MAX_REDACTION_ENTRIES) {
        out["__truncated__"] = TRUNCATED_SENTINEL;
        break;
      }
      entryCount++;
      try {
        out[key] = sanitizeFieldValueForSink(key, value, resolved, seen, depth, inherited);
      } catch {
        out[key] = EXOTIC_SENTINEL; // X1/X6: fail-closed on per-field access errors
      }
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
  options?: { allowDirectMask?: boolean; forceDoubleFallback?: boolean },
): unknown {
  if (typeof value === "string") {
    if (options?.allowDirectMask) {
      const textSanitized = sanitizeStringForSink(value, resolved, { allowDirectMask: true });
      // forceDoubleFallback is only set for credential contexts. When true, force-mask
      // strings that pattern-redaction did not alter (C3: slash-charset bypass).
      // EC3 guard: never force-mask ISO-8601 timestamps even in credential context.
      if (options.forceDoubleFallback && textSanitized === value) {
        if (/^\d{4}-\d{2}-\d{2}T/u.test(value)) {
          return value;
        }
        return maskDirectSecret(value);
      }
      return textSanitized;
    }
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
  // X3: Hard depth cap to prevent DoS via deeply nested payloads.
  if (depth >= MAX_REDACTION_DEPTH) {
    return DEPTH_SENTINEL;
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (value instanceof Error) {
    return sanitizeErrorForSink(value, resolved, seen, depth);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValueForSink(entry, resolved, seen, depth + 1, options));
  }
  if (typeof value === "object") {
    // X6: Wrap toJSON access in a try-catch so that Proxy traps or throwing
    // getters cannot crash the sanitization pass.
    let maybeToJson: (() => unknown) | undefined;
    try {
      maybeToJson = (value as { toJSON?: () => unknown }).toJSON;
    } catch {
      // Proxy/getter threw — treat as exotic object (X1: fail-closed).
      return EXOTIC_SENTINEL;
    }

    if (typeof maybeToJson === "function" && !seen.has(value)) {
      seen.add(value);
      try {
        const serialized = maybeToJson.call(value);
        return sanitizeValueForSink(serialized, resolved, seen, depth + 1, options);
      } catch {
        // X6: toJSON threw — fall through to record-level sanitization rather
        // than propagating the error. The object's enumerable keys will be
        // traversed instead, which is the safe fallback.
      } finally {
        seen.delete(value);
      }
    }

    // X1: Wrap the entire record sanitization in a try-catch. If an exotic
    // object (e.g. a Proxy with a throwing get-trap) causes an unexpected
    // error, return a safe placeholder rather than leaking raw values or
    // crashing the transport write path.
    try {
      return sanitizeRecordForSink(value as JsonLikeRecord, resolved, seen, depth, options);
    } catch {
      return EXOTIC_SENTINEL;
    }
  }
  return value;
}

/**
 * Sanitize a full log record before it is written to a sink (file, transport).
 *
 * @param record   The raw log record object from the logger.
 * @param resolved Pre-resolved redaction options (required — no default).
 *                 Obtain via `getLoggingRedactionPolicy().resolved`.
 * @returns        A sanitized copy of the record (SanitizedLogRecord), or the
 *                 original record unchanged when redaction is disabled.
 */
export function sanitizeLogRecordForSink(
  record: Record<string, unknown>,
  resolved: ResolvedRedactOptions,
): SanitizedLogRecord {
  if (shouldBypassRedaction(resolved)) {
    return record;
  }
  // X1: Top-level fail-closed: if the entire sanitization throws unexpectedly
  // (e.g. an exotic object at the root), return a minimal safe placeholder
  // rather than re-throwing or returning the raw record.
  try {
    const result = sanitizeValueForSink(record, resolved, new WeakSet<object>(), 0);
    return result as SanitizedLogRecord;
  } catch {
    return { __sanitizationError__: EXOTIC_SENTINEL };
  }
}
