import type { MemoryArtifact, MemoryContentObject } from "../../types.js";
import { extractAsrText } from "./asr.js";
import { extractCaptionText } from "./caption.js";
import { extractOcrText } from "./ocr.js";

export type ExtractedText = {
  text: string;
  source: "ocr" | "asr" | "caption";
  artifactId?: string;
  artifactKind?: MemoryArtifact["kind"];
};

function extractForArtifact(artifact: MemoryArtifact): ExtractedText[] {
  const results: ExtractedText[] = [];

  for (const text of extractOcrText(artifact)) {
    results.push({
      text,
      source: "ocr",
      artifactId: artifact.id,
      artifactKind: artifact.kind,
    });
  }

  for (const text of extractAsrText(artifact)) {
    results.push({
      text,
      source: "asr",
      artifactId: artifact.id,
      artifactKind: artifact.kind,
    });
  }

  for (const text of extractCaptionText(artifact)) {
    results.push({
      text,
      source: "caption",
      artifactId: artifact.id,
      artifactKind: artifact.kind,
    });
  }

  return results;
}

export function extractTextFromContent(content: MemoryContentObject): ExtractedText[] {
  const artifacts = content.artifacts ?? [];
  const results: ExtractedText[] = [];
  for (const artifact of artifacts) {
    results.push(...extractForArtifact(artifact));
  }
  return results;
}
