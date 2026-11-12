import { formatTokenCount } from "../utils/usage-format.js";

export const formatTokensPairValue = (input?: number | null, output?: number | null) => {
  if (input == null && output == null) {
    return null;
  }
  const inputLabel = input == null ? "?" : formatTokenCount(input);
  const outputLabel = output == null ? "?" : formatTokenCount(output);
  return `${inputLabel} in / ${outputLabel} out`;
};

export const formatCacheHitValue = (
  input?: number | null,
  cacheRead?: number | null,
  cacheWrite?: number | null,
) => {
  if ((cacheRead == null || cacheRead < 0) && (cacheWrite == null || cacheWrite < 0)) {
    return null;
  }

  const cachedLabel = formatTokenCount(cacheRead ?? 0);
  const newLabel = formatTokenCount(cacheWrite ?? 0);

  const totalInput = (cacheRead ?? 0) + (cacheWrite ?? 0) + (input ?? 0);
  const hitRate = totalInput > 0 ? Math.round(((cacheRead ?? 0) / totalInput) * 100) : 0;

  return `${hitRate}% hit · ${cachedLabel} cached, ${newLabel} new`;
};

export const formatContextTokensValue = (
  total: number | null | undefined,
  contextTokens: number | null,
) => {
  const ctxLabel = contextTokens ? formatTokenCount(contextTokens) : "?";
  if (total == null) {
    return `?/${ctxLabel}`;
  }
  const pct = contextTokens ? Math.min(999, Math.round((total / contextTokens) * 100)) : null;
  const totalLabel = formatTokenCount(total);
  return `${totalLabel}/${ctxLabel}${pct !== null ? ` (${pct}%)` : ""}`;
};
