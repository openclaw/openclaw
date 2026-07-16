/**
 * JSON parser compatibility helper for persisted config, manifests, and legacy stores.
 * Strict JSON stays the fast path; JSON5 is only the authored/legacy fallback.
 *
 * When both parsers fail, the JSON parse error message is included in the
 * rethrown error so callers have diagnostic context without bypassing
 * caller-owned sanitization.
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
      const jsonErrMsg =
        jsonError instanceof Error ? jsonError.message : String(jsonError);
      throw new Error(
        `JSON.parse failed, and JSON5 fallback also failed: ${jsonErrMsg}`,
        { cause: json5Error },
      );
    }
  }
}

