import { parseByteSize } from "../cli/parse-bytes.js";

/**
 * Parse an optional byte-size value from config.
 * Accepts non-negative numbers or strings like "2mb".
 */
export function parseNonNegativeByteSize(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const int = Math.floor(value);
    return int >= 0 ? int : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    try {
      const bytes = parseByteSize(trimmed, { defaultUnit: "b" });
      return bytes >= 0 ? bytes : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function isValidNonNegativeByteSizeString(value: string): boolean {
  return parseNonNegativeByteSize(value) !== null;
}
