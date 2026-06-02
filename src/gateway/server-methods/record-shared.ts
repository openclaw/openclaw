export { asOptionalRecord as asRecord } from "../../../packages/normalization-core/src/record-coerce.js";

/** Normalizes user/RPC text fields where blank strings should behave like absence. */
export function normalizeTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
