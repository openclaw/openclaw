export function makeZeroUsageSnapshot() {
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
const asFiniteNumber = (value) => {
    if (typeof value !== "number") {
        return undefined;
    }
    if (!Number.isFinite(value)) {
        return undefined;
    }
    return value;
};
export function hasNonzeroUsage(usage) {
    if (!usage) {
        return false;
    }
    return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.total].some((v) => typeof v === "number" && Number.isFinite(v) && v > 0);
}
export function normalizeUsage(raw) {
    if (!raw) {
        return undefined;
    }
    // Some providers (pi-ai OpenAI-format) pre-subtract cached_tokens from
    // prompt_tokens upstream.  When cached_tokens > prompt_tokens the result is
    // negative, which is nonsensical.  Clamp to 0.
    const rawInput = asFiniteNumber(raw.input ?? raw.inputTokens ?? raw.input_tokens ?? raw.promptTokens ?? raw.prompt_tokens);
    const input = rawInput !== undefined && rawInput < 0 ? 0 : rawInput;
    const output = asFiniteNumber(raw.output ??
        raw.outputTokens ??
        raw.output_tokens ??
        raw.completionTokens ??
        raw.completion_tokens);
    const cacheRead = asFiniteNumber(raw.cacheRead ??
        raw.cache_read ??
        raw.cache_read_input_tokens ??
        raw.cached_tokens ??
        raw.prompt_tokens_details?.cached_tokens);
    const cacheWrite = asFiniteNumber(raw.cacheWrite ?? raw.cache_write ?? raw.cache_creation_input_tokens);
    const total = asFiniteNumber(raw.total ?? raw.totalTokens ?? raw.total_tokens);
    if (input === undefined &&
        output === undefined &&
        cacheRead === undefined &&
        cacheWrite === undefined &&
        total === undefined) {
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
export function derivePromptTokens(usage) {
    if (!usage) {
        return undefined;
    }
    const input = usage.input ?? 0;
    const cacheRead = usage.cacheRead ?? 0;
    const cacheWrite = usage.cacheWrite ?? 0;
    const sum = input + cacheRead + cacheWrite;
    return sum > 0 ? sum : undefined;
}
export function deriveSessionTotalTokens(params) {
    const promptOverride = params.promptTokens;
    const hasPromptOverride = typeof promptOverride === "number" && Number.isFinite(promptOverride) && promptOverride > 0;
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
