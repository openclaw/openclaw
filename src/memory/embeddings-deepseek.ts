import { resolveRemoteEmbeddingBearerClient } from "./embeddings-remote-client.js";
import { fetchRemoteEmbeddingVectors } from "./embeddings-remote-fetch.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.js";

export type DeepseekEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  model: string;
};

export const DEFAULT_DEEPSEEK_EMBEDDING_MODEL = "deepseek-embedding";
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";

export function normalizeDeepseekModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return DEFAULT_DEEPSEEK_EMBEDDING_MODEL;
  }
  if (trimmed.startsWith("deepseek/")) {
    return trimmed.slice("deepseek/".length);
  }
  return trimmed;
}

export async function createDeepseekEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<{ provider: EmbeddingProvider; client: DeepseekEmbeddingClient }> {
  const client = await resolveDeepseekEmbeddingClient(options);
  const url = `${client.baseUrl.replace(/\/$/, "")}/embeddings`;

  const embed = async (input: string[]): Promise<number[][]> => {
    if (input.length === 0) {
      return [];
    }
    return await fetchRemoteEmbeddingVectors({
      url,
      headers: client.headers,
      body: { model: client.model, input },
      errorPrefix: "deepseek embeddings failed",
    });
  };

  return {
    provider: {
      id: "deepseek",
      model: client.model,
      embedQuery: async (text) => {
        const [vec] = await embed([text]);
        return vec ?? [];
      },
      embedBatch: embed,
    },
    client,
  };
}

export async function resolveDeepseekEmbeddingClient(
  options: EmbeddingProviderOptions,
): Promise<DeepseekEmbeddingClient> {
  const { baseUrl, headers } = await resolveRemoteEmbeddingBearerClient({
    provider: "deepseek",
    options,
    defaultBaseUrl: DEFAULT_DEEPSEEK_BASE_URL,
  });
  const model = normalizeDeepseekModel(options.model);
  return { baseUrl, headers, model };
}
