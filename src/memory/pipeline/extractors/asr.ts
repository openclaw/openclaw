import type { MemoryArtifact } from "../../types.js";

const ASR_TEXT_KEYS = ["transcript", "asrText", "asr_text", "subtitle"] as const;

export function extractAsrText(artifact: MemoryArtifact): string[] {
  if (artifact.kind !== "audio" && artifact.kind !== "video" && artifact.kind !== "file") {
    return [];
  }

  const metadata = artifact.metadata;
  if (!metadata || typeof metadata !== "object") {
    return [];
  }

  const results: string[] = [];
  for (const key of ASR_TEXT_KEYS) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim().length > 0) {
      results.push(value.trim());
    }
  }

  return results;
}
