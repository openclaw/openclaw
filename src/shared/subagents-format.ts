export { formatDurationCompact } from "../infra/format-time/format-duration.ts";

export function formatTokenShort(value?: number) {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  const n = Math.floor(value);
  if (n === 0) {
    return "0";
  }
  if (n < 1_000) {
    return `${n}`;
  }
  if (n < 10_000) {
    return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (n < 1_000_000) {
    return `${Math.round(n / 1_000)}k`;
  }
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

export function truncateLine(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength).trimEnd()}...`;
}

export type TokenUsageLike = {
  totalTokens?: unknown;
  totalTokensFresh?: unknown;
  totalTokensEstimate?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
};

export function resolveTotalTokens(
  entry?: TokenUsageLike,
  options?: { allowStaleEstimate?: boolean; excludeIoTotals?: boolean },
) {
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  if (
    (entry.totalTokensFresh === true || entry.totalTokensFresh === undefined) &&
    typeof entry.totalTokens === "number" &&
    Number.isFinite(entry.totalTokens) &&
    entry.totalTokens >= 0
  ) {
    return entry.totalTokens;
  }
  if (
    options?.allowStaleEstimate &&
    typeof entry.totalTokensEstimate === "number" &&
    Number.isFinite(entry.totalTokensEstimate) &&
    entry.totalTokensEstimate >= 0
  ) {
    return entry.totalTokensEstimate;
  }
  if (
    options?.allowStaleEstimate &&
    typeof entry.totalTokens === "number" &&
    Number.isFinite(entry.totalTokens) &&
    entry.totalTokens >= 0
  ) {
    return entry.totalTokens;
  }
  if (options?.excludeIoTotals) {
    return undefined;
  }
  const input: number =
    typeof entry.inputTokens === "number" && Number.isFinite(entry.inputTokens)
      ? entry.inputTokens
      : 0;
  const output: number =
    typeof entry.outputTokens === "number" && Number.isFinite(entry.outputTokens)
      ? entry.outputTokens
      : 0;
  const total = input + output;
  if (
    (typeof entry.inputTokens === "number" &&
      Number.isFinite(entry.inputTokens) &&
      entry.inputTokens > 0) ||
    (typeof entry.outputTokens === "number" &&
      Number.isFinite(entry.outputTokens) &&
      entry.outputTokens > 0)
  ) {
    return total;
  }
  return undefined;
}

export function resolveIoTokens(entry?: TokenUsageLike) {
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  if (
    typeof entry.inputTokens !== "number" ||
    !Number.isFinite(entry.inputTokens) ||
    typeof entry.outputTokens !== "number" ||
    !Number.isFinite(entry.outputTokens)
  ) {
    if (typeof entry.inputTokens === "number" && Number.isFinite(entry.inputTokens)) {
      return { input: entry.inputTokens, output: 0, total: entry.inputTokens };
    }
    if (typeof entry.outputTokens === "number" && Number.isFinite(entry.outputTokens)) {
      return { input: 0, output: entry.outputTokens, total: entry.outputTokens };
    }
    return undefined;
  }
  const input: number = entry.inputTokens;
  const output: number = entry.outputTokens;
  const total = input + output;
  return { input, output, total };
}

export function formatTokenUsageDisplay(entry?: TokenUsageLike) {
  const io = resolveIoTokens(entry);
  const promptCache = resolveTotalTokens(entry);
  const parts: string[] = [];
  if (io) {
    const input = formatTokenShort(io.input) ?? "0";
    const output = formatTokenShort(io.output) ?? "0";
    parts.push(`tokens ${formatTokenShort(io.total)} (in ${input} / out ${output})`);
  } else if (promptCache !== undefined && promptCache > 0) {
    parts.push(`tokens ${formatTokenShort(promptCache)} prompt/cache`);
  }
  if (io && promptCache !== undefined && promptCache > io.total) {
    parts.push(`prompt/cache ${formatTokenShort(promptCache)}`);
  }
  return parts.join(", ");
}
