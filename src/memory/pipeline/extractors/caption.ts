import type { MemoryArtifact } from "../../types.js";

const CAPTION_KEYS = ["caption", "alt", "altText", "summary", "description"] as const;

export function extractCaptionText(artifact: MemoryArtifact): string[] {
  if (artifact.kind !== "image" && artifact.kind !== "video" && artifact.kind !== "file") {
    return [];
  }

  const metadata = artifact.metadata;
  if (!metadata || typeof metadata !== "object") {
    return [];
  }

  const results: string[] = [];
  for (const key of CAPTION_KEYS) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim().length > 0) {
      results.push(value.trim());
    }
  }

  return results;
}
