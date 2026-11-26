/** Prompt-cache hit rate shared by the Control UI and chat `/context` reports. */
export type PromptCacheUsage = {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** Input from calls that reported no cache split; their cache use is unknown. */
  cacheUnmeasuredInput?: number;
};

/** Prompt tokens of calls that reported how much of their prompt the cache served. */
export const measuredPromptTokens = (usage: PromptCacheUsage) =>
  usage.input - (usage.cacheUnmeasuredInput ?? 0) + usage.cacheRead + usage.cacheWrite;

/** Share of measured prompt tokens read from the provider cache; null when none were measured. */
export function promptCacheHitRate(usage: PromptCacheUsage): number | null {
  const prompt = measuredPromptTokens(usage);
  return prompt > 0 ? usage.cacheRead / prompt : null;
}

/** Floors, so 100.00% only appears when every prompt token was a cache read. */
export const formatPromptCacheHitRate = (rate: number | null) =>
  rate === null ? "—" : `${(Math.floor(rate * 10_000) / 100).toFixed(2)}%`;
