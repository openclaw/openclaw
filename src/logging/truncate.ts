import { sliceUtf16Safe } from "../utils.js";

export type TruncateForLogOptions = {
  /**
   * Maximum characters to keep in logs. The returned string will be at most this
   * length (unless the truncation marker itself exceeds the budget, in which
   * case we hard-slice).
   */
  maxChars?: number;
};

const DEFAULT_MAX_CHARS = 4_000;

/**
 * Truncate potentially-large text for logging.
 *
 * Prefer this when logging command stdout/stderr, tool debug details, or any
 * other untrusted text blob that can explode log volume.
 */
export function truncateForLog(input: string, options: TruncateForLogOptions = {}): string {
  const maxChars =
    typeof options.maxChars === "number" && Number.isFinite(options.maxChars)
      ? Math.max(0, Math.floor(options.maxChars))
      : DEFAULT_MAX_CHARS;

  if (maxChars === 0) {
    return "";
  }
  if (input.length <= maxChars) {
    return input;
  }

  const excess = input.length - maxChars;
  const markerWithCount = `\n…[truncated ${excess} chars]…\n`;
  const markerFallback = "\n…[truncated]…\n";
  const marker = markerWithCount.length <= maxChars ? markerWithCount : markerFallback;
  const budget = maxChars - marker.length;
  if (budget <= 0) {
    return sliceUtf16Safe(input, 0, maxChars);
  }

  const headLen = Math.ceil(budget / 2);
  const tailLen = budget - headLen;
  return `${sliceUtf16Safe(input, 0, headLen)}${marker}${sliceUtf16Safe(input, -tailLen)}`;
}
