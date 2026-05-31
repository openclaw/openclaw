export { asOptionalRecord as asRecord } from "../../../packages/normalization-core/src/record-coerce.js";

/** Return a trimmed non-empty string for permissive gateway payload fields. */
export function normalizeTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
