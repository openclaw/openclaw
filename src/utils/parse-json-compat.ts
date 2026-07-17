/**
 * JSON parser compatibility helper for persisted config, manifests, and legacy stores.
 * Strict JSON stays the fast path; JSON5 is only the authored/legacy fallback.
 *
 * When both parsers fail, the JSON5 diagnostic is preserved as the top-level
 * error message (backward compatible), and the strict JSON.parse error is
 * attached as `cause` so callers can access it without raw-input exposure in logs.
 */
import JSON5 from "json5";

/** Parses strict JSON first, then accepts JSON5 syntax such as comments and trailing commas. */
export function parseJsonWithJson5Fallback(
  raw: string,
  json5: { parse: (value: string) => unknown } = JSON5,
): unknown {
  try {
    return JSON.parse(raw);
  } catch (jsonError) {
    try {
      return json5.parse(raw);
    } catch (json5Error) {
      const json5ErrMsg =
        json5Error instanceof Error ? json5Error.message : String(json5Error);
      throw new Error(
        `JSON5 fallback also failed: ${json5ErrMsg}`,
        { cause: jsonError instanceof Error ? jsonError : new Error(String(jsonError)) },
      );
    }
  }
}