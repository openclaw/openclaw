export type UsageLike = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
  // Common alternates across providers/SDKs.
  inputTokens?: number;
  outputTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  // Some agents/logs emit alternate naming.
  totalTokens?: number;
  total_tokens?: number;
  cache_read?: number;
  cache_write?: number;
};

export type NormalizedUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

const asFiniteNumber = (value: unknown): number | undefined => {
  if (typeof value !== "number") {
    return undefined;
  }
  if (!Number.isFinite(value)) {
    return undefined;
  }
  return value;
};

export function hasNonzeroUsage(usage?: NormalizedUsage | null): usage is NormalizedUsage {
  if (!usage) {
    return false;
  }
  return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.total].some(
    (v) => typeof v === "number" && Number.isFinite(v) && v > 0,
  );
}

export function normalizeUsage(raw?: UsageLike | null): NormalizedUsage | undefined {
  if (!raw) {
    return undefined;
  }

  const input = asFiniteNumber(
    raw.input ?? raw.inputTokens ?? raw.input_tokens ?? raw.promptTokens ?? raw.prompt_tokens,
  );
  const output = asFiniteNumber(
    raw.output ??
      raw.outputTokens ??
      raw.output_tokens ??
      raw.completionTokens ??
      raw.completion_tokens,
  );
  const cacheRead = asFiniteNumber(raw.cacheRead ?? raw.cache_read ?? raw.cache_read_input_tokens);
  const cacheWrite = asFiniteNumber(
    raw.cacheWrite ?? raw.cache_write ?? raw.cache_creation_input_tokens,
  );
  const total = asFiniteNumber(raw.total ?? raw.totalTokens ?? raw.total_tokens);

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
  if (!usage) {
    return undefined;
  }
  // Use only `input` for context-window accounting.
  // `cacheRead` and `cacheWrite` are informational metrics for cost tracking —
  // cached tokens are already part of the prompt and don't consume additional
  // context window capacity.  Including them inflated context % and triggered
  // premature auto-compaction (see #13853).
  const input = usage.input ?? 0;
  return input > 0 ? input : undefined;
}

export function deriveSessionTotalTokens(params: {
  usage?: {
    input?: number;
    total?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  contextTokens?: number;
}): number | undefined {
  const usage = params.usage;
  if (!usage) {
    return undefined;
  }
  const input = usage.input ?? 0;
  const promptTokens = derivePromptTokens({
    input: usage.input,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
  });
  let total = promptTokens ?? usage.total ?? input;
  if (!(total > 0)) {
    return undefined;
  }

  const contextTokens = params.contextTokens;
  if (typeof contextTokens === "number" && Number.isFinite(contextTokens) && contextTokens > 0) {
    total = Math.min(total, contextTokens);
  }
  return total;
}
