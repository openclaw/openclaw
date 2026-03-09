import { isDeepStrictEqual } from "node:util";
import JSON5 from "json5";

export function replaceSensitiveValuesInRaw(params: {
  raw: string;
  sensitiveValues: string[];
  redactedSentinel: string;
}): string {
  // Empty strings carry no redaction information, but String#replaceAll("", x)
  // inserts the replacement between every character and can blow up the raw
  // config payload into an invalid-length string. Deduplicate while filtering
  // them out so repeated empty/duplicate secrets stay cheap and safe.
  const values = [...new Set(params.sensitiveValues.filter((value) => value.length > 0))].toSorted(
    (a, b) => b.length - a.length,
  );
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
