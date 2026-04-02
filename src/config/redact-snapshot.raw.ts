import { isDeepStrictEqual } from "node:util";
import JSON5 from "json5";

export function replaceSensitiveValuesInRaw(params: {
  raw: string;
  sensitiveValues: string[];
  redactedSentinel: string;
}): string {
  // Empty string is not a valid replacement token here: replaceAll("", x)
  // matches every character boundary and corrupts the whole raw snapshot.
  const values = [...new Set(params.sensitiveValues)]
    .filter((value) => value !== "")
    .toSorted((a, b) => b.length - a.length);
  let result = params.raw;
  for (const value of values) {
    result = result.replaceAll(value, params.redactedSentinel);
  }
  return result;
}

/**
 * Strip keys with `undefined` values so that objects materialized with
 * `void 0` assignments compare cleanly against JSON-parsed objects
 * (which can never contain `undefined`).
 */
function stripUndefinedKeys(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

export function shouldFallbackToStructuredRawRedaction(params: {
  redactedRaw: string;
  originalConfig: unknown;
  /** Source (pre-materialize) config for comparison; falls back to originalConfig. */
  sourceConfig?: unknown;
  restoreParsed: (parsed: unknown) => { ok: boolean; result?: unknown };
}): boolean {
  try {
    const parsed = JSON5.parse(params.redactedRaw);
    const restored = params.restoreParsed(parsed);
    if (!restored.ok) {
      return true;
    }
    const compareTarget = params.sourceConfig ?? params.originalConfig;
    return !isDeepStrictEqual(
      stripUndefinedKeys(restored.result),
      stripUndefinedKeys(compareTarget),
    );
  } catch {
    return true;
  }
}
