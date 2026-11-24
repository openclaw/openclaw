import {
  asNonNegativeFiniteNumber,
  asPositiveFiniteNumber,
} from "@openclaw/normalization-core/number-coercion";
import type { SessionEntry } from "../config/sessions/types.js";
import { formatTokenCount } from "../utils/token-format.js";

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

export const formatEstimatedContextBudgetTokens = (
  status: SessionEntry["contextBudgetStatus"] | undefined,
  contextTokens: number | null | undefined,
) => {
  if (!status || status.source !== "pre-prompt-estimate") {
    return null;
  }
  const estimate = asNonNegativeFiniteNumber(status.estimatedPromptTokens);
  if (estimate === undefined) {
    return null;
  }
  const estimatedPromptTokens = Math.floor(estimate);
  const ctx = asPositiveFiniteNumber(contextTokens);
  const pct = ctx ? Math.min(999, Math.round((estimatedPromptTokens / ctx) * 100)) : null;
  const totalLabel = formatTokenCount(estimatedPromptTokens);
  const ctxLabel = ctx ? formatTokenCount(ctx) : "?";
  return `~${totalLabel}/${ctxLabel}${pct !== null ? ` (${pct}% est)` : " (est)"}`;
};
