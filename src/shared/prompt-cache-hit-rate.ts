import { asNonNegativeFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asNullableObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { isTranscriptOnlyOpenClawAssistantMessage } from "./transcript-only-openclaw-assistant.js";

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

/** Prompt cache share across the model calls since the latest user message that reported
 *  a cache split; a call with unknown usage or cache use is left out, never counted as a miss. */
export function latestRunCacheHitRate(messages: readonly unknown[] | undefined): number | null {
  const totals = { input: 0, cacheRead: 0, cacheWrite: 0 };
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = asNullableObjectRecord(messages?.[index]);
    if (message?.role === "user") {
      break;
    }
    if (message?.role !== "assistant" || isTranscriptOnlyOpenClawAssistantMessage(message)) {
      continue;
    }
    const usage = asNullableObjectRecord(message.usage);
    if (
      asNullableObjectRecord(usage?.usageReport)?.state === "unavailable" ||
      asNullableObjectRecord(usage?.cacheTelemetry)?.state === "unavailable"
    ) {
      continue;
    }
    for (const key of ["input", "cacheRead", "cacheWrite"] as const) {
      totals[key] += asNonNegativeFiniteNumber(usage?.[key]) ?? 0;
    }
  }
  return promptCacheHitRate(totals);
}

/** Floors, so 100.00% only appears when every prompt token was a cache read. */
export const formatPromptCacheHitRate = (rate: number | null) =>
  rate === null ? "—" : `${(Math.floor(rate * 10_000) / 100).toFixed(2)}%`;
