import { resolveRemoteEmbeddingBearerClient } from "./embeddings-remote-client.js";
import { fetchRemoteEmbeddingVectors } from "./embeddings-remote-fetch.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.js";

export type JinaEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  model: string;
};

export const DEFAULT_JINA_EMBEDDING_MODEL = "jina-embeddings-v5-text-nano";
const DEFAULT_JINA_BASE_URL = "https://api.jina.ai/v1";
const JINA_MAX_INPUT_TOKENS: Record<string, number> = {
  "jina-embeddings-v5-text-nano": 8192,
  "jina-embeddings-v5-text-small": 32768,
};

export function normalizeJinaModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return DEFAULT_JINA_EMBEDDING_MODEL;
  }
  if (trimmed.startsWith("jina/")) {
    return trimmed.slice("jina/".length);
  }
  return trimmed;
}

export async function createJinaEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<{ provider: EmbeddingProvider; client: JinaEmbeddingClient }> {
  const client = await resolveJinaEmbeddingClient(options);
  const url = `${client.baseUrl.replace(/\/$/, "")}/embeddings`;

  const embed = async (
    input: string[],
    task?: "retrieval.query" | "retrieval.passage",
  ): Promise<number[][]> => {
    if (input.length === 0) {
      return [];
    }
    const body: { model: string; input: string[]; task?: "retrieval.query" | "retrieval.passage" } =
      {
        model: client.model,
        input,
      };
    if (task) {
      body.task = task;
    }

    return await fetchRemoteEmbeddingVectors({
      url,
      headers: client.headers,
      body,
      errorPrefix: "jina embeddings failed",
    });
  };

  return {
    provider: {
      id: "jina",
      model: client.model,
      maxInputTokens: JINA_MAX_INPUT_TOKENS[client.model],
      embedQuery: async (text) => {
        const [vec] = await embed([text], "retrieval.query");
        return vec ?? [];
      },
      embedBatch: async (texts) => embed(texts, "retrieval.passage"),
    },
    client,
  };
}

export async function resolveJinaEmbeddingClient(
  options: EmbeddingProviderOptions,
): Promise<JinaEmbeddingClient> {
  const { baseUrl, headers } = await resolveRemoteEmbeddingBearerClient({
    provider: "jina",
    options,
    defaultBaseUrl: DEFAULT_JINA_BASE_URL,
  });
  const model = normalizeJinaModel(options.model);
  return { baseUrl, headers, model };
}
