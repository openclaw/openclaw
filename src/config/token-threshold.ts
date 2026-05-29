/**
 * Resolve a compaction token threshold that may be an absolute number or a
 * percentage string (e.g. "40%").
 *
 * Percentage strings are resolved against the active model's context window at
 * runtime; the result can vary per session when the model changes.
 *
 * When the threshold is undefined, the defaultAbsolute value is returned
 * unchanged so existing unset config continues to behave as before.
 */
export function resolveTokenThreshold(
  threshold: number | string | undefined,
  contextWindowTokens: number,
  defaultAbsolute: number,
): number {
  if (typeof threshold === "number" && Number.isFinite(threshold)) {
    return threshold;
  }
  if (typeof threshold === "string") {
    const match = threshold.match(/^(\d+)%$/);
    if (match) {
      return Math.floor((contextWindowTokens * Number.parseInt(match[1], 10)) / 100);
    }
  }
  return defaultAbsolute;
}
