/** Resolves finite webhook numeric options to clamped integer values. */
export function resolveWebhookIntegerOption(
  value: number | undefined,
  fallback: number,
  params: {
    /** Inclusive lower bound after fallback and flooring. */
    min: number;
  },
): number {
  const candidate = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(params.min, Math.floor(candidate));
}
