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

/** Hard cap on nesting depth to prevent DoS via deeply nested payloads. */
const MAX_REDACTION_DEPTH = 16;
/** Hard cap on number of entries per record to prevent DoS via very wide objects. */
const MAX_REDACTION_ENTRIES = 1024;

const DIRECT_SECRET_MIN_LENGTH = 18;
const DIRECT_SECRET_KEEP_START = 6;
const DIRECT_SECRET_KEEP_END = 4;

/**
 * The set of object-prototype keys that can be abused for prototype pollution
 * or are otherwise dangerous to propagate into log output. These are filtered
 * unconditionally before building the sanitized output record.
 */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// ── Types ───────────────────────────────────────────────────────────────────

type JsonLikeRecord = Record<string, unknown>;

/**
 * Explicit return type for sanitized log records. Using a named alias rather
 * than a generic `<T extends Record<…>>` avoids the false impression that
 * prototype descriptors, class methods, etc. are preserved post-sanitization.
 */
export type SanitizedLogRecord = Record<string, unknown>;

/**
 * Encodes how strongly a field's value should be masked and how that strength
 * propagates to descendant fields during recursive sanitization.
 *
 *   None  — no inherited context; masking decisions are made per-field.
 *   Soft  — inherited from a message/arg ancestor; charset gate applies (soft mask).
 *   Force — inherited from a credential-key ancestor; unconditional force-mask.
 *
 * Using a three-value enum instead of `{ allowDirectMask, forceDoubleFallback }`
 * boolean pairs prevents the two inheritance paths (message vs credential) from
 * collapsing into the same state, which was the root cause of CR4.
 */
const enum MaskStrength {
  None = 0,
  Soft = 1,
  Force = 2,
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
 * Returns true for field names that represent human-readable message positions.
 * These keys get a soft allowDirectMask promotion — the charset gate still applies —
 * so that token-like strings in `message` and positional arg fields are masked when
 * they look like secrets, but non-secret strings (e.g. ISO timestamps) pass through.
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
 * character-set heuristic but must NOT be masked. The prefix test
 * (`/^\d{4}-\d{2}-\d{2}T/`) is checked first and exits early so timestamps
 * pass through unmodified.
 */
function shouldMaskDirectString(value: string): boolean {
  // Exclude ISO-8601 date-time strings from direct masking.
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
 *
 * @returns The sanitized string, or a masked placeholder if the input looks like
 *          a secret token and `allowDirectMask` is set.
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

/**
 * Resolves the MaskStrength that applies to a field, taking into account both
 * the field's own key name and any strength inherited from an ancestor.
 *
 * Priority order (highest to lowest):
 *   1. inherited === Force  → Force (credential context propagates unconditionally)
 *   2. isCredentialFieldName(key) → Force (credential key always escalates)
 *   3. inherited === Soft   → Soft  (message context propagates, but never escalates)
 *   4. shouldAllowDirectStringFallback(key) → Soft (message/arg key originates Soft)
 *   5. default → None
 */
function resolveMaskStrength(key: string, inherited: MaskStrength): MaskStrength {
  if (inherited === MaskStrength.Force) {
    return MaskStrength.Force;
  }
  if (isCredentialFieldName(key)) {
    return MaskStrength.Force;
  }
  if (inherited === MaskStrength.Soft) {
    return MaskStrength.Soft;
  }
  if (shouldAllowDirectStringFallback(key)) {
    return MaskStrength.Soft;
  }
  return MaskStrength.None;
}

function sanitizeFieldValueForSink(
  key: string,
  value: unknown,
  resolved: ResolvedRedactOptions,
  seen: WeakSet<object>,
  depth: number,
  inherited: MaskStrength = MaskStrength.None,
): unknown {
  const strength = resolveMaskStrength(key, inherited);
  const isCredentialContext = strength === MaskStrength.Force;

  if (typeof value === "string") {
    if (isCredentialContext) {
      const textSanitized = sanitizeStringForSink(value, resolved, { allowDirectMask: true });
      // Double-fallback: if pattern redaction did not touch the string, force-mask
      // it unconditionally. This handles tokens with character sets (e.g. containing
      // `/`) that the charset gate does not flag but that are unambiguously secrets
      // by virtue of sitting under a credential-named key.
      // Exception: ISO-8601 timestamps are never force-masked even under credential keys.
      if (textSanitized === value) {
        if (/^\d{4}-\d{2}-\d{2}T/u.test(value)) {
          return value;
        }
        return maskDirectSecret(value);
      }
      return textSanitized;
    }
    // For message/msg/arg-key and non-credential keys: use sanitizeStringForSink
    // which applies the shouldMaskDirectString charset gate as a soft fallback.
    return sanitizeStringForSink(value, resolved, {
      allowDirectMask: strength === MaskStrength.Soft,
    });
  }

  // For non-string values: propagate the resolved strength downward so that
  // deeply nested strings (e.g. toJSON results, array entries) inherit the
  // correct context. Force propagates unconditionally; Soft applies charset
  // gate only; None passes no inherited context.
  return sanitizeValueForSink(value, resolved, seen, depth + 1, strength);
}

function sanitizeErrorForSink(
  error: Error,
  resolved: ResolvedRedactOptions,
  seen: WeakSet<object>,
  depth: number,
  inherited: MaskStrength = MaskStrength.None,
): JsonLikeRecord | string {
  if (seen.has(error)) {
    return CIRCULAR_SENTINEL;
  }
  seen.add(error);
  try {
    const out: JsonLikeRecord = Object.create(null) as JsonLikeRecord;
    out.name = sanitizeStringForSink(error.name, resolved);
    out.message = sanitizeStringForSink(error.message, resolved, {
      allowDirectMask: inherited !== MaskStrength.None,
    });
    if (typeof error.stack === "string") {
      out.stack = sanitizeStringForSink(error.stack, resolved);
    }
    const errorWithCause = error as Error & { cause?: unknown };
    if ("cause" in errorWithCause && errorWithCause.cause !== undefined) {
      // Intentionally do NOT propagate credential context into the Error.cause path.
      // Credential fields inside cause will be recaptured by isCredentialFieldName
      // on the inner key, so we avoid over-redacting useful debugging data (e.g.
      // error codes, timestamps) that may live alongside secrets in nested Error objects.
      out.cause = sanitizeValueForSink(errorWithCause.cause, resolved, seen, depth + 1);
    }
    // Custom Error properties are sanitized via sanitizeFieldValueForSink which
    // re-checks isCredentialFieldName on each key. The inherited strength is
    // forwarded so that Force context (e.g. { token: new Error(...) }) propagates
    // through Error boundaries into custom Error properties.
    for (const [key, value] of Object.entries(error as unknown as JsonLikeRecord)) {
      if (DANGEROUS_KEYS.has(key)) {
        continue; // filter prototype-pollution keys
      }
      try {
        out[key] = sanitizeFieldValueForSink(key, value, resolved, seen, depth, inherited);
      } catch {
        out[key] = EXOTIC_SENTINEL; // fail-closed on per-field access errors
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
  inherited: MaskStrength = MaskStrength.None,
): SanitizedLogRecord | string {
  if (seen.has(record)) {
    return CIRCULAR_SENTINEL;
  }
  seen.add(record);
  try {
    // Use Object.create(null) so the output has no prototype chain.
    const out: JsonLikeRecord = Object.create(null) as JsonLikeRecord;
    let entryCount = 0;
    for (const [key, value] of Object.entries(record)) {
      // Hard-filter dangerous keys to prevent prototype-chain pollution.
      if (DANGEROUS_KEYS.has(key)) {
        continue;
      }
      // Hard cap on entries per record to prevent DoS via very wide objects.
      if (entryCount >= MAX_REDACTION_ENTRIES) {
        out["__truncated__"] = TRUNCATED_SENTINEL;
        break;
      }
      entryCount++;
      try {
        out[key] = sanitizeFieldValueForSink(key, value, resolved, seen, depth, inherited);
      } catch {
        out[key] = EXOTIC_SENTINEL; // fail-closed on per-field access errors
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
  inherited: MaskStrength = MaskStrength.None,
): unknown {
  if (typeof value === "string") {
    if (inherited !== MaskStrength.None) {
      const textSanitized = sanitizeStringForSink(value, resolved, { allowDirectMask: true });
      // Force context: if pattern redaction did not alter the string, apply the
      // double-fallback unconditionally (handles tokens with `/` or other chars
      // that the charset gate misses).
      // Exception: ISO-8601 timestamps are never force-masked.
      if (inherited === MaskStrength.Force && textSanitized === value) {
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
  // Hard depth cap to prevent DoS via deeply nested payloads.
  if (depth >= MAX_REDACTION_DEPTH) {
    return DEPTH_SENTINEL;
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (value instanceof Error) {
    return sanitizeErrorForSink(value, resolved, seen, depth, inherited);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValueForSink(entry, resolved, seen, depth + 1, inherited));
  }
  if (typeof value === "object") {
    // Wrap toJSON access in a try-catch so that Proxy traps or throwing
    // getters cannot crash the sanitization pass.
    let maybeToJson: (() => unknown) | undefined;
    try {
      maybeToJson = (value as { toJSON?: () => unknown }).toJSON;
    } catch {
      // Proxy/getter threw — return a safe placeholder rather than crashing.
      return EXOTIC_SENTINEL;
    }

    if (typeof maybeToJson === "function" && !seen.has(value)) {
      seen.add(value);
      try {
        const serialized = maybeToJson.call(value);
        return sanitizeValueForSink(serialized, resolved, seen, depth + 1, inherited);
      } catch {
        // toJSON threw — fall through to record-level sanitization.
        // The object's enumerable keys will be traversed as a safe fallback.
      } finally {
        seen.delete(value);
      }
    }

    // Wrap record sanitization so that exotic objects (e.g. Proxy with a
    // throwing get-trap) return a safe placeholder instead of propagating.
    try {
      return sanitizeRecordForSink(value as JsonLikeRecord, resolved, seen, depth, inherited);
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
  // Top-level fail-closed: if sanitization throws unexpectedly (e.g. an exotic
  // object at the root), return a minimal safe placeholder rather than re-throwing
  // or returning the raw record which may contain secrets.
  try {
    const result = sanitizeValueForSink(record, resolved, new WeakSet<object>(), 0);
    return result as SanitizedLogRecord;
  } catch {
    return { __sanitizationError__: EXOTIC_SENTINEL };
  }
}
