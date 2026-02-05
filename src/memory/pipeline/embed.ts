import type { EmbedderAdapter } from "../interfaces.js";
import type { MemoryContentObject } from "../types.js";

export type EmbedWarning = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export async function embedEpisodes(params: {
  episodes: MemoryContentObject[];
  embedder?: EmbedderAdapter;
}): Promise<{ embeddings: Map<string, number[]>; warnings: EmbedWarning[] }> {
  const warnings: EmbedWarning[] = [];
  const embeddings = new Map<string, number[]>();
  const { episodes, embedder } = params;

  if (!embedder) {
    warnings.push({
      code: "embed.missing_adapter",
      message: "Embedder adapter is not configured; skipping embedding stage.",
    });
    return { embeddings, warnings };
  }

  if (embedder.embedBatch) {
    const inputs = episodes.map((episode) => ({
      id: episode.id,
      text: episode.text ?? "",
      metadata: episode.metadata,
    }));
    const vectors = await embedder.embedBatch(inputs);
    vectors.forEach((vector, index) => {
      const episode = episodes[index];
      if (episode) {
        embeddings.set(episode.id, vector);
      }
    });
    return { embeddings, warnings };
  }

  for (const episode of episodes) {
    const text = episode.text ?? "";
    if (text.trim().length === 0) continue;
    const vector = await embedder.embed({ id: episode.id, text, metadata: episode.metadata });
    embeddings.set(episode.id, vector);
  }

  return { embeddings, warnings };
}
