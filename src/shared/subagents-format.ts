import { formatCompactTokenCount } from "@openclaw/normalization-core";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { SESSION_TOTAL_TOKENS_VERSION } from "../config/sessions/types.js";

function formatTokenShort(value?: number) {
  if (!value || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const n = Math.floor(value);
  return formatCompactTokenCount(n, {
    thousandsPrecision: n >= 10_000 ? 0 : 1,
    trimTrailingZero: true,
  });
}

export function truncateLine(value: string, maxLength: number) {
  const limit = Math.max(0, Math.floor(maxLength));
  const trimmed = value.trimEnd();
  if (trimmed.length <= limit) {
    return trimmed;
  }
  const marker = "...";
  if (limit <= marker.length) {
    return marker.slice(0, limit);
  }
  return `${truncateUtf16Safe(trimmed, limit - marker.length).trimEnd()}${marker}`;
}

type TokenUsageLike = {
  totalTokens?: unknown;
  totalTokensFresh?: unknown;
  totalTokensVersion?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
};

export function resolveTotalTokens(entry?: TokenUsageLike) {
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  if (
    typeof entry.totalTokens === "number" &&
    Number.isFinite(entry.totalTokens) &&
    entry.totalTokensFresh === true &&
    entry.totalTokensVersion === SESSION_TOTAL_TOKENS_VERSION
  ) {
    return entry.totalTokens;
  }
  const input = typeof entry.inputTokens === "number" ? entry.inputTokens : 0;
  const output = typeof entry.outputTokens === "number" ? entry.outputTokens : 0;
  const total = input + output;
  return total > 0 ? total : undefined;
}

export function formatTokenUsageDisplay(entry?: TokenUsageLike) {
  if (!entry || typeof entry !== "object") {
    return "";
  }
  const inputTokens =
    typeof entry.inputTokens === "number" && Number.isFinite(entry.inputTokens)
      ? entry.inputTokens
      : 0;
  const outputTokens =
    typeof entry.outputTokens === "number" && Number.isFinite(entry.outputTokens)
      ? entry.outputTokens
      : 0;
  const total = inputTokens + outputTokens;
  const hasIo = !(total <= 0);
  const contextTokens = resolveTotalTokens(entry);
  const parts: string[] = [];
  if (hasIo) {
    const input = formatTokenShort(inputTokens) ?? "0";
    const output = formatTokenShort(outputTokens) ?? "0";
    parts.push(`tokens ${formatTokenShort(total)} (in ${input} / out ${output})`);
  } else if (typeof contextTokens === "number" && contextTokens > 0) {
    parts.push(`tokens ${formatTokenShort(contextTokens)} context`);
  }
  if (typeof contextTokens === "number" && hasIo && contextTokens > total) {
    parts.push(`context ${formatTokenShort(contextTokens)}`);
  }
  return parts.join(", ");
}
