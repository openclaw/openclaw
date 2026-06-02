import { asOptionalRecord } from "../../../packages/normalization-core/src/record-coerce.js";

/**
 * Returns a non-array record for RPC payload subtrees.
 *
 * Malformed JSON subtrees become `undefined` instead of empty objects so
 * callers can distinguish absent optional config from invalid nested shapes.
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return asOptionalRecord(value);
}

/** Returns non-empty caller text after trimming, or `undefined` for absent/blank values. */
export function normalizeTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
