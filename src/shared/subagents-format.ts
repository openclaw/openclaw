export function formatDurationCompact(valueMs?: number) {
  if (!valueMs || !Number.isFinite(valueMs) || valueMs <= 0) {
    return "n/a";
  }
  const minutes = Math.max(1, Math.round(valueMs / 60_000));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const minutesRemainder = minutes % 60;
  if (hours < 24) {
    return minutesRemainder > 0 ? `${hours}h${minutesRemainder}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const hoursRemainder = hours % 24;
  return hoursRemainder > 0 ? `${days}d${hoursRemainder}h` : `${days}d`;
}

export function formatTokenShort(value?: number) {
  if (!value || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const n = Math.floor(value);
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
  inputTokens?: unknown;
  outputTokens?: unknown;
};

export function resolveTotalTokens(entry?: TokenUsageLike) {
  // Defensive check: entry must be a non-null object
  if (!entry || entry === null || typeof entry !== "object") {
    return undefined;
  }
  try {
    if (
      typeof entry.totalTokens === "number" &&
      Number.isFinite(entry.totalTokens) &&
      entry.totalTokens >= 0
    ) {
      return entry.totalTokens;
    }
    const input = typeof entry.inputTokens === "number" ? entry.inputTokens : 0;
    const output = typeof entry.outputTokens === "number" ? entry.outputTokens : 0;
    const total = input + output;
    return total > 0 ? total : undefined;
  } catch {
    // Guard against unexpected property access errors (e.g., Proxy objects)
    return undefined;
  }
}

export function resolveIoTokens(entry?: TokenUsageLike) {
  if (!entry || entry === null || typeof entry !== "object") {
    return undefined;
  }
  try {
    const input =
      typeof entry.inputTokens === "number" && Number.isFinite(entry.inputTokens)
        ? entry.inputTokens
        : 0;
    const output =
      typeof entry.outputTokens === "number" && Number.isFinite(entry.outputTokens)
        ? entry.outputTokens
        : 0;
    const total = input + output;
    if (total <= 0) {
      return undefined;
    }
    return { input, output, total };
  } catch {
    // Guard against unexpected property access errors
    return undefined;
  }
}

export function formatTokenUsageDisplay(entry?: TokenUsageLike) {
  try {
    const io = resolveIoTokens(entry);
    const promptCache = resolveTotalTokens(entry);
    const parts: string[] = [];
    if (io) {
      const input = formatTokenShort(io.input) ?? "0";
      const output = formatTokenShort(io.output) ?? "0";
      parts.push(`tokens ${formatTokenShort(io.total)} (in ${input} / out ${output})`);
    } else if (typeof promptCache === "number" && promptCache > 0) {
      parts.push(`tokens ${formatTokenShort(promptCache)} prompt/cache`);
    }
    if (typeof promptCache === "number" && io && promptCache > io.total) {
      parts.push(`prompt/cache ${formatTokenShort(promptCache)}`);
    }
    return parts.join(", ");
  } catch {
    // Final guard: if anything fails, return empty string (no usage info)
    return "";
  }
}
