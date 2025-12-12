export type UsageLike = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
  // Some agents/logs emit alternate naming.
  totalTokens?: number;
  total_tokens?: number;
  cache_read?: number;
  cache_write?: number;
};

const asFiniteNumber = (value: unknown): number | undefined => {
  if (typeof value !== "number") return undefined;
  if (!Number.isFinite(value)) return undefined;
  return value;
};

export function normalizeUsage(raw?: UsageLike | null):
  | {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      total?: number;
    }
  | undefined {
  if (!raw) return undefined;

  const input = asFiniteNumber(raw.input);
  const output = asFiniteNumber(raw.output);
  const cacheRead = asFiniteNumber(raw.cacheRead ?? raw.cache_read);
  const cacheWrite = asFiniteNumber(raw.cacheWrite ?? raw.cache_write);
  const total = asFiniteNumber(
    raw.total ?? raw.totalTokens ?? raw.total_tokens,
  );

  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    total === undefined
  ) {
    return undefined;
  }

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total,
  };
}

export function derivePromptTokens(usage?: {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
}): number | undefined {
  if (!usage) return undefined;
  const input = usage.input ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const sum = input + cacheRead + cacheWrite;
  return sum > 0 ? sum : undefined;
}
