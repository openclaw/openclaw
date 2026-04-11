import { isPlainObject } from "../utils.js";

/**
 * Coerce tool-call params into a plain object.
 *
 * Some providers stream tool-call arguments as incremental string deltas.
 * By the time the framework invokes hooks or execution callbacks, the
 * accumulated value may still be a JSON string rather than a parsed object.
 */
export function coerceToolParamsRecord(value: unknown): Record<string, unknown> {
  if (isPlainObject(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isPlainObject(parsed)) {
          return parsed;
        }
      } catch {
        // not valid JSON - fall through to empty object
      }
    }
  }
  return {};
}
