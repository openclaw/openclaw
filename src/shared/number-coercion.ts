/** Shared numeric coercion facade for legacy imports inside core. */
export * from "@openclaw/normalization-core/number-coercion";
<<<<<<< HEAD

export function resolveNonNegativeNumber(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
