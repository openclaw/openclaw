import crypto from "node:crypto";
import type { MemoryContentObject, MemoryProvenance, MemoryTemporalMetadata } from "../types.js";
import { extractTextFromContent } from "./extractors/index.js";

export type ExtractWarning = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

function buildEpisode(params: {
  baseId: string;
  text: string;
  provenance?: MemoryProvenance;
  temporal?: MemoryTemporalMetadata;
  metadata?: Record<string, unknown>;
}): MemoryContentObject {
  return {
    id: `${params.baseId}:${crypto.randomUUID()}`,
    kind: "episode",
    text: params.text,
    provenance: params.provenance,
    temporal: params.temporal,
    metadata: params.metadata,
  };
}

export function extractEpisodesFromContent(contents: MemoryContentObject[]): {
  episodes: MemoryContentObject[];
  warnings: ExtractWarning[];
} {
  const episodes: MemoryContentObject[] = [];
  const warnings: ExtractWarning[] = [];

  for (const content of contents) {
    if (content.text && content.text.trim().length > 0) {
      episodes.push(
        buildEpisode({
          baseId: content.id,
          text: content.text.trim(),
          provenance: content.provenance,
          temporal: content.temporal,
          metadata: { source: "text" },
        }),
      );
    }

    const extracted = extractTextFromContent(content);
    for (const entry of extracted) {
      episodes.push(
        buildEpisode({
          baseId: content.id,
          text: entry.text,
          provenance: content.provenance,
          temporal: content.temporal,
          metadata: {
            source: entry.source,
            artifactId: entry.artifactId,
            artifactKind: entry.artifactKind,
          },
        }),
      );
    }

    if (!content.text && extracted.length === 0) {
      warnings.push({
        code: "extract.no_text",
        message: "Content item produced no extractable text.",
        details: { id: content.id, kind: content.kind },
      });
    }
  }

  return { episodes, warnings };
}
