import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";

/**
 * Shared boolean coercion helpers for config, env, and plugin SDK runtime inputs.
 *
 * `asBoolean` is intentionally strict; string parsing is opt-in through
 * `parseBooleanValue` so schema callers do not silently accept ambiguous text.
 */

/** Accepted string literals for boolean parsing beyond actual booleans. */
type BooleanParseOptions = {
  /** Lowercase string values that should parse as true. */
  truthy?: string[];
  /** Lowercase string values that should parse as false. */
  falsy?: string[];
};

const DEFAULT_TRUTHY: readonly string[] = ["true", "1", "yes", "on"];
const DEFAULT_FALSY: readonly string[] = ["false", "0", "no", "off"];

/** Returns only real boolean values and leaves boolean-like strings for explicit parsing. */
export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Parses booleans and configured string literals, returning undefined for ambiguous input. */
export function parseBooleanValue(
  value: unknown,
  options: BooleanParseOptions = {},
): boolean | undefined {
  const booleanValue = asBoolean(value);
  if (booleanValue !== undefined) {
    return booleanValue;
  }
  const normalized = normalizeOptionalLowercaseString(value);
  if (!normalized) {
    return undefined;
  }
  if ((options.truthy ?? DEFAULT_TRUTHY).includes(normalized)) {
    return true;
  }
  if ((options.falsy ?? DEFAULT_FALSY).includes(normalized)) {
    return false;
  }
  return undefined;
}
