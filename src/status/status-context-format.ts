import { formatTokenCount } from "../utils/usage-format.js";

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
