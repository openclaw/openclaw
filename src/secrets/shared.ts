/** Shared parsing helpers for secrets migration/runtime code. */
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
export { resolvePositiveTimerTimeoutMs as normalizePositiveTimerMs } from "@openclaw/normalization-core/number-coercion";
export { isRecord } from "@openclaw/normalization-core/record-coerce";
export { hasNonEmptyString as isNonEmptyString } from "@openclaw/normalization-core/string-coerce";

/**
 * Parses a simple .env assignment value, stripping one matching quote pair after trimming.
 */
export function parseEnvValue(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Normalizes numeric config to a positive integer, falling back when the input is not finite.
 */
export function normalizePositiveInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.floor(value));
  }
  return Math.max(1, Math.floor(fallback));
}

/**
 * Splits a dotted config path into non-empty trimmed segments.
 */
export function parseDotPath(pathname: string): string[] {
  return normalizeStringEntries(pathname.split("."));
}
