/**
 * Detects redacted-placeholder pollution in a parsed config object so the
 * recovery path can refuse to restore from a backup that was clobbered by an
 * agent writing tool-output redactions back to disk (#68423).
 *
 * Scope: secret-shaped string values such as apiKey/token/password/secret/key.
 * Patterns matched:
 *  - "***" (and longer asterisk runs) — common generic redaction
 *  - "<short prefix>...<short suffix>" — OpenClaw maskApiKey output shape
 *  - "<short prefix>…<short suffix>" — unicode-ellipsis variants
 */

const SECRET_FIELD_SUFFIXES = [
  "apikey",
  "api_key",
  "secret",
  "token",
  "password",
  "passcode",
  "credential",
];

const ASTERISK_REDACTION = /^\*{3,}$/;
const SHORT_TOKEN_BOUND = 12;
const ELLIPSIS_REDACTION = /^[\w+/=:.\-@]{1,12}(?:\.{3}|\u2026)[\w+/=:.\-@]{1,12}$/;

function isSecretFieldName(key: string): boolean {
  const lower = key.toLowerCase();
  return SECRET_FIELD_SUFFIXES.some((suffix) => lower === suffix || lower.endsWith(suffix));
}

function isRedactedValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (ASTERISK_REDACTION.test(trimmed)) {
    return true;
  }
  // Constrain ellipsis-shaped redactions to short tokens so high-entropy
  // real secrets that happen to contain dots are not flagged.
  if (trimmed.length <= SHORT_TOKEN_BOUND * 2 + 3 && ELLIPSIS_REDACTION.test(trimmed)) {
    return true;
  }
  return false;
}

function walk(value: unknown, path: string[], hits: string[]): void {
  if (value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      walk(value[i], [...path, String(i)], hits);
    }
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const nextPath = [...path, key];
    if (typeof child === "string" && isSecretFieldName(key) && isRedactedValue(child)) {
      hits.push(nextPath.join("."));
      continue;
    }
    walk(child, nextPath, hits);
  }
}

export function findRedactedSecretSites(parsed: unknown): string[] {
  const hits: string[] = [];
  walk(parsed, [], hits);
  return hits;
}
