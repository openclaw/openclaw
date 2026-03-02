import {
  createRemoteEmbeddingProvider,
  resolveRemoteEmbeddingClient,
} from "./embeddings-remote-provider.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.js";

export type OpenrouterEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  model: string;
};

export const DEFAULT_OPENROUTER_EMBEDDING_MODEL = "openai/text-embedding-3-small";
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export function normalizeOpenrouterModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return DEFAULT_OPENROUTER_EMBEDDING_MODEL;
  }
  return trimmed;
}

export async function createOpenrouterEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<{ provider: EmbeddingProvider; client: OpenrouterEmbeddingClient }> {
  const client = await resolveRemoteEmbeddingClient({
    provider: "openrouter",
    options,
    defaultBaseUrl: DEFAULT_OPENROUTER_BASE_URL,
    normalizeModel: normalizeOpenrouterModel,
  });

  return {
    provider: createRemoteEmbeddingProvider({
      id: "openrouter",
      client,
      errorPrefix: "openrouter embeddings failed",
    }),
    client,
  };
}
