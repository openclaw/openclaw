import { formatCompactTokenCount } from "@openclaw/normalization-core";
import { asNonNegativeFiniteNumber } from "@openclaw/normalization-core/number-coercion";

/** Formats a token count for compact human-facing status text. */
export function formatTokenCount(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "0";
  }
  const safe = Math.max(0, value);
  return formatCompactTokenCount(safe, { thousandsPrecision: safe >= 10_000 ? 0 : 1 });
}

export function resolvePromptCacheStats(usage: {
  inputTokens?: number | null;
  totalTokens?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
}) {
  const cacheRead = asNonNegativeFiniteNumber(usage.cacheRead) ?? 0;
  const cacheWrite = asNonNegativeFiniteNumber(usage.cacheWrite) ?? 0;
  const inputTokens = asNonNegativeFiniteNumber(usage.inputTokens);
  // Explicit prompt parts take precedence over legacy totals that may undershoot cached usage.
  const total =
    inputTokens === undefined
      ? Math.max(asNonNegativeFiniteNumber(usage.totalTokens) ?? 0, cacheRead + cacheWrite)
      : inputTokens + cacheRead + cacheWrite;
  return {
    cacheRead,
    cacheWrite,
    hitRate: total > 0 ? Math.round((cacheRead / total) * 100) : 0,
  };
}
