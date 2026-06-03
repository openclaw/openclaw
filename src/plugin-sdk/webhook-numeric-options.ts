/** Resolve webhook numeric options by rejecting non-finite input, flooring fractions, and enforcing a minimum. */
export function resolveWebhookIntegerOption(
  value: number | undefined,
  fallback: number,
  params: { min: number },
): number {
  const candidate = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(params.min, Math.floor(candidate));
}
