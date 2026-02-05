import type { MemoryArtifact } from "../../types.js";

const OCR_TEXT_KEYS = ["ocrText", "ocr_text", "text", "extractedText"] as const;

export function extractOcrText(artifact: MemoryArtifact): string[] {
  if (artifact.kind !== "image" && artifact.kind !== "file") {
    return [];
  }

  const metadata = artifact.metadata;
  if (!metadata || typeof metadata !== "object") {
    return [];
  }

  const results: string[] = [];
  for (const key of OCR_TEXT_KEYS) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim().length > 0) {
      results.push(value.trim());
    }
  }

  return results;
}
