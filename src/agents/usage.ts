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
  // Moonshot/Kimi uses cached_tokens for cache read count (explicit caching API).
  cached_tokens?: number;
  // Kimi K2 uses prompt_tokens_details.cached_tokens for automatic prefix caching.
  prompt_tokens_details?: { cached_tokens?: number };
  // Some agents/logs emit alternate naming.
  totalTokens?: number;
  total_tokens?: number;
  cache_read?: number;
  cache_write?: number;
  // Google Gemini native usageMetadata field names.
  // NOTE: promptTokenCount INCLUDES cached content tokens. When
  // cachedContentTokenCount is also present we split the two so that
  // derivePromptTokens() and estimateUsageCost() handle them correctly.
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  candidatesTokenCount?: number;
  // Newer Gemini SDK uses responseTokenCount instead of candidatesTokenCount.
  responseTokenCount?: number;
  // totalTokenCount covers "prompt + response candidates + tool-use prompts"
  // per the Gemini SDK — it does NOT include thoughtsTokenCount.
  totalTokenCount?: number;
  // thoughtsTokenCount is billed separately and excluded from totalTokenCount.
  // We add it to the normalized total so cost/usage reporting is complete.
  thoughtsTokenCount?: number;
};

export type NormalizedUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

export type AssistantUsageSnapshot = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
};

export function makeZeroUsageSnapshot(): AssistantUsageSnapshot {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

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

  // Some providers (pi-ai OpenAI-format) pre-subtract cached_tokens from
  // prompt_tokens upstream.  When cached_tokens > prompt_tokens the result is
  // negative, which is nonsensical.  Clamp to 0.

  // Google Gemini: promptTokenCount INCLUDES cachedContentTokenCount.
  // When both are present, split them so cacheRead gets the cached portion
  // and input gets only the non-cached prompt tokens.  This lets
  // derivePromptTokens() (input + cacheRead + cacheWrite) stay correct and
  // estimateUsageCost() apply the cheaper cache-read rate.
  const geminiPrompt = asFiniteNumber(raw.promptTokenCount);
  const geminiCached = asFiniteNumber(raw.cachedContentTokenCount);

  const rawInput = asFiniteNumber(
    raw.input ??
      raw.inputTokens ??
      raw.input_tokens ??
      raw.promptTokens ??
      raw.prompt_tokens ??
      (geminiPrompt !== undefined && geminiCached !== undefined
        ? geminiPrompt - geminiCached
        : geminiPrompt),
  );
  const input = rawInput !== undefined && rawInput < 0 ? 0 : rawInput;
  const output = asFiniteNumber(
    raw.output ??
      raw.outputTokens ??
      raw.output_tokens ??
      raw.completionTokens ??
      raw.completion_tokens ??
      raw.candidatesTokenCount ??
      raw.responseTokenCount,
  );
  const cacheRead = asFiniteNumber(
    raw.cacheRead ??
      raw.cache_read ??
      raw.cache_read_input_tokens ??
      raw.cached_tokens ??
      raw.prompt_tokens_details?.cached_tokens ??
      geminiCached,
  );
  const cacheWrite = asFiniteNumber(
    raw.cacheWrite ?? raw.cache_write ?? raw.cache_creation_input_tokens,
  );

  // Gemini's totalTokenCount excludes thoughtsTokenCount (per SDK docs).
  // Add thoughts back so the normalized total covers all billed tokens.
  const geminiThoughts = asFiniteNumber(raw.thoughtsTokenCount);
  const rawTotal = asFiniteNumber(
    raw.total ?? raw.totalTokens ?? raw.total_tokens ?? raw.totalTokenCount,
  );
  const total =
    rawTotal !== undefined && geminiThoughts !== undefined ? rawTotal + geminiThoughts : rawTotal;

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
  const input = usage.input ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const sum = input + cacheRead + cacheWrite;
  return sum > 0 ? sum : undefined;
}

export function deriveSessionTotalTokens(params: {
  usage?: {
    input?: number;
    output?: number;
    total?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  contextTokens?: number;
  promptTokens?: number;
}): number | undefined {
  const promptOverride = params.promptTokens;
  const hasPromptOverride =
    typeof promptOverride === "number" && Number.isFinite(promptOverride) && promptOverride > 0;

  const usage = params.usage;
  if (!usage && !hasPromptOverride) {
    return undefined;
  }

  // NOTE: SessionEntry.totalTokens is used as a prompt/context snapshot.
  // It intentionally excludes completion/output tokens.
  const promptTokens = hasPromptOverride
    ? promptOverride
    : derivePromptTokens({
        input: usage?.input,
        cacheRead: usage?.cacheRead,
        cacheWrite: usage?.cacheWrite,
      });

  if (!(typeof promptTokens === "number") || !Number.isFinite(promptTokens) || promptTokens <= 0) {
    return undefined;
  }

  // Keep this value unclamped; display layers are responsible for capping
  // percentages for terminal output.
  return promptTokens;
}
