import { isDeepStrictEqual } from "node:util";
import JSON5 from "json5";

export function replaceSensitiveValuesInRaw(params: {
  raw: string;
  sensitiveValues: string[];
  redactedSentinel: string;
}): string {
  // Filter out empty strings before sorting: replaceAll("", sentinel) inserts
  // the sentinel between every character, which can balloon the string to
  // hundreds of megabytes and throw a RangeError: Invalid string length.
  const values = [...params.sensitiveValues]
    .filter((v) => v.length > 0)
    .toSorted((a, b) => b.length - a.length);
  let result = params.raw;
  for (const value of values) {
    result = result.replaceAll(value, params.redactedSentinel);
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
