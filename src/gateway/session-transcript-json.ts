// Shared bounded JSONL metadata parsing for gateway transcript readers.
import { escapeRegExp } from "../shared/regexp.js";

export function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function extractJsonStringFieldPrefix(prefix: string, field: string): string | undefined {
  const match = new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`).exec(prefix);
  if (!match) {
    return undefined;
  }
  try {
    const decoded = JSON.parse(`"${match[1]}"`) as unknown;
    return normalizeOptionalString(decoded);
  } catch {
    return undefined;
  }
}

export function extractJsonNullableStringFieldPrefix(
  prefix: string,
  field: string,
): string | null | undefined {
  if (new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*null`).test(prefix)) {
    return null;
  }
  return extractJsonStringFieldPrefix(prefix, field);
}

export function extractJsonNumberFieldPrefix(prefix: string, field: string): number | undefined {
  const match = new RegExp(
    `"${escapeRegExp(field)}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`,
  ).exec(prefix);
  if (!match) {
    return undefined;
  }
  const decoded = Number(match[1]);
  return Number.isFinite(decoded) ? decoded : undefined;
}
