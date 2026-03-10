import { isDeepStrictEqual } from "node:util";
import JSON5 from "json5";

/**
 * Redacts sensitive values from a raw config string.
 * Filters out empty/null/undefined values to prevent RangeError (#41247).
 *
 * Note: When `params.raw` is not a string, this returns an empty string
 * defensively instead of returning a stringified unredacted value.
 */
export function replaceSensitiveValuesInRaw(params: {
  raw: string;
  sensitiveValues: string[];
  redactedSentinel: string;
}): string {
  // Defensive: validate input types
  if (typeof params.raw !== "string") {
    return "";
  }

  // Defensive: normalize and filter sensitive values
  // Empty strings cause RangeError in String.replaceAll (#41247)
  const values = [...params.sensitiveValues]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .toSorted((a, b) => b.length - a.length);

  // Early return if no valid values to redact
  if (values.length === 0) {
    return params.raw;
  }

  // Defensive: ensure sentinel is valid
  const sentinel =
    typeof params.redactedSentinel === "string" && params.redactedSentinel.length > 0
      ? params.redactedSentinel
      : "__REDACTED__";

  let result = params.raw;
  for (const value of values) {
    result = result.replaceAll(value, sentinel);
  }
  return result;
}

export function shouldFallbackToStructuredRawRedaction(params: {
  redactedRaw: string;
  originalConfig: unknown;
  restoreParsed: (parsed: unknown) => { ok: boolean; result?: unknown };
}): boolean {
  try {
    const parsed = JSON5.parse(params.redactedRaw);
    const restored = params.restoreParsed(parsed);
    if (!restored.ok) {
      return true;
    }
    return !isDeepStrictEqual(restored.result, params.originalConfig);
  } catch {
    return true;
  }
}
