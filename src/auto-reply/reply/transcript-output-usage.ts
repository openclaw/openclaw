import type { AgentMessage } from "../../agents/runtime/index.js";
import type { NormalizedUsage } from "../../agents/usage.js";
import { deriveContextPromptTokens, normalizeUsage } from "../../agents/usage.js";

export type SessionTranscriptUsageSnapshot = {
  promptTokens?: number;
  outputTokens?: number;
  trailingMessages: AgentMessage[];
};

function deriveTranscriptOutputTokens(
  usage: Pick<NormalizedUsage, "contextUsage" | "output">,
): number | undefined {
  const outputRaw =
    usage.contextUsage?.state === "available"
      ? usage.contextUsage.totalTokens - usage.contextUsage.promptTokens
      : usage.output;
  return typeof outputRaw === "number" && Number.isFinite(outputRaw) && outputRaw > 0
    ? outputRaw
    : undefined;
}

export function deriveTranscriptUsageSnapshot(
  usage: NonNullable<ReturnType<typeof normalizeUsage>>,
  trailingMessages: AgentMessage[],
): SessionTranscriptUsageSnapshot | undefined {
  const promptTokens = deriveContextPromptTokens({ lastCallUsage: usage });
  const outputTokens = deriveTranscriptOutputTokens(usage);
  if (!(typeof promptTokens === "number") && !(typeof outputTokens === "number")) {
    return undefined;
  }
  return {
    promptTokens,
    outputTokens,
    trailingMessages,
  };
}
