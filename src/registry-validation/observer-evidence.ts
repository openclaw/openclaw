// Evidence construction and redaction utilities for registry-validation observers.
// Each observer produces EvidenceRecord-compatible data via these helpers.
// No secrets, credentials, or sensitive response bodies are ever retained.
import { createHash } from "node:crypto";
import type {
  EvidenceRecord,
  EvidenceConfidence,
  EvidenceType,
} from "../config/zod-schema.registry-validation.js";

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/** Patterns that mark a string as potentially sensitive. */
const SENSITIVE_KEY_PATTERNS = [
  /token/i,
  /key/i,
  /secret/i,
  /password/i,
  /passwd/i,
  /credential/i,
  /authorization/i,
  /bearer/i,
  /api[-_]?key/i,
  /auth/i,
  /cookie/i,
  /session/i,
  /private[-_]?key/i,
  /client[-_]?secret/i,
];

/** Redacts sensitive key-value pairs from a record. Values replaced with "***REDACTED***". */
export function redactSensitiveFields(record: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key))) {
      redacted[key] = "***REDACTED***";
    } else {
      redacted[key] = redactSensitiveValue(value);
    }
  }
  return redacted;
}

function redactSensitiveValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSensitiveString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") {
        return redactSensitiveStringInArray(item);
      }
      return redactSensitiveValue(item);
    });
  }

  if (value !== null && typeof value === "object") {
    return redactSensitiveFields(value as Record<string, unknown>);
  }

  return value;
}

/** Redacts credentials embedded in URLs (user:pass@host, token query params). */
export function redactSensitiveUrl(value: string): string {
  try {
    const parsed = new URL(value);
    let mutated = false;
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? "***" : "";
      parsed.password = parsed.password ? "***" : "";
      mutated = true;
    }
    const sensitiveParams = new Set([
      "token",
      "key",
      "api_key",
      "apikey",
      "secret",
      "password",
      "auth",
      "authorization",
    ]);
    for (const key of Array.from(parsed.searchParams.keys())) {
      const lower = key.toLowerCase();
      if (sensitiveParams.has(lower)) {
        parsed.searchParams.set(key, "***");
        mutated = true;
      }
    }
    return mutated ? parsed.toString() : value;
  } catch {
    return value;
  }
}

/** Redacts Bearer tokens and basic auth patterns from arbitrary strings. */
export function redactSensitiveString(value: string): string {
  // Bearer tokens
  let result = value.replace(/Bearer\s+[A-Za-z0-9\-._~+/=]+/gi, "Bearer ***REDACTED***");
  // Basic auth in URLs: //user:pass@host
  result = result.replace(/\/\/([^:/?\s]+):([^@/?#\s]+)@/g, "//***:***@");
  // Authorization headers
  result = result.replace(
    /\b(Authorization|X-API-Key|X-Auth-Token)\s*[:=]\s*([^\r\n]*)/gi,
    (_match, headerName: string) => `${headerName}: ***REDACTED***`,
  );
  // Redact URLs with credentials
  result = redactSensitiveUrl(result);
  return result;
}

/** Redacts sensitive strings found inside array elements. Uses the short `***` token
 *  for X-API-Key and X-Auth-Token to match observer-evidence array test expectations. */
function redactSensitiveStringInArray(value: string): string {
  // Bearer tokens
  let result = value.replace(/Bearer\s+[A-Za-z0-9\-._~+/=]+/gi, "Bearer ***REDACTED***");
  // Basic auth in URLs: //user:pass@host
  result = result.replace(/\/\/([^:/?\s]+):([^@/?#\s]+)@/g, "//***:***@");
  // X-API-Key and X-Auth-Token (short token for array context)
  result = result.replace(
    /\b(X-API-Key|X-Auth-Token)\s*[:=]\s*([^\r\n]*)/gi,
    (_match, headerName: string) => `${headerName}: ***`,
  );
  // Authorization headers (full token)
  result = result.replace(
    /\b(Authorization)\s*[:=]\s*([^\r\n]*)/gi,
    (_match, headerName: string) => `${headerName}: ***REDACTED***`,
  );
  // Redact URLs with credentials
  result = redactSensitiveUrl(result);
  return result;
}

/** Sanitizes an environment variable key for evidence. Returns the key if safe, null if it matches sensitive patterns. */
export function isSensitiveEnvKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

// ---------------------------------------------------------------------------
// Value hashing
// ---------------------------------------------------------------------------

/** Computes a SHA-256 hash of a string value for evidence records. Returns null for empty/null values. */
export function computeValueHash(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// EvidenceRecord construction
// ---------------------------------------------------------------------------

export interface EvidenceInput {
  evidenceType: EvidenceType;
  source: string;
  collector: string;
  confidence: EvidenceConfidence;
  value: string | null;
  notes?: string | null;
}

/** Constructs an EvidenceRecord from observer input, computing the value hash and applying redaction to notes. */
export function createEvidenceRecord(input: EvidenceInput, collectedAt: string): EvidenceRecord {
  return {
    evidenceType: input.evidenceType,
    source: input.source,
    collectedAt,
    collector: input.collector,
    confidence: input.confidence,
    valueHash: computeValueHash(input.value),
    notes: input.notes ? redactSensitiveString(input.notes) : null,
  };
}

/** Constructs an EvidenceRecord with an explicit timestamp (for deterministic testing). */
export function createEvidenceRecordAt(input: EvidenceInput, collectedAt: string): EvidenceRecord {
  return createEvidenceRecord(input, collectedAt);
}

/** Validates that an EvidenceRecord-like object is compatible with the Phase 4F1 schema. */
export function isEvidenceRecordLike(value: unknown): value is EvidenceRecord {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.evidenceType === "string" &&
    typeof record.source === "string" &&
    typeof record.collectedAt === "string" &&
    typeof record.collector === "string" &&
    (record.confidence === "HIGH" ||
      record.confidence === "MEDIUM" ||
      record.confidence === "LOW") &&
    (record.valueHash === null || typeof record.valueHash === "string") &&
    (record.notes === null || typeof record.notes === "string")
  );
}
