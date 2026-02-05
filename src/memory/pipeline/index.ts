import type { VectorAdapter } from "../interfaces.js";
import type { MemoryContentObject } from "../types.js";

export type IndexWarning = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export async function indexEpisodes(params: {
  episodes: MemoryContentObject[];
  embeddings: Map<string, number[]>;
  vectorAdapter?: VectorAdapter;
}): Promise<{ warnings: IndexWarning[] }> {
  const warnings: IndexWarning[] = [];
  const { episodes, embeddings, vectorAdapter } = params;

  if (!vectorAdapter) {
    warnings.push({
      code: "index.missing_adapter",
      message: "Vector adapter is not configured; skipping index stage.",
    });
    return { warnings };
  }

  const records = episodes
    .map((episode) => ({
      episode,
      vector: embeddings.get(episode.id),
    }))
    .filter((entry) => entry.vector && entry.vector.length > 0);

  if (records.length === 0) {
    warnings.push({
      code: "index.no_vectors",
      message: "No embeddings were available for indexing.",
    });
    return { warnings };
  }

  await vectorAdapter.upsert(
    records.map((record) => ({
      id: record.episode.id,
      values: record.vector!,
      metadata: record.episode.metadata,
    })),
  );

  return { warnings };
}
