import type { NormalizedUsage } from "../../agents/usage.js";

export function deriveTranscriptOutputTokens(
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
