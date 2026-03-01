import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { resolveRemoteEmbeddingBearerClient } from "./embeddings-remote-client.js";
import { fetchRemoteEmbeddingVectors } from "./embeddings-remote-fetch.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.js";

export type MistralEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  model: string;
};

export const DEFAULT_MISTRAL_EMBEDDING_MODEL = "mistral-embed";
const DEFAULT_MISTRAL_BASE_URL = "https://api.mistral.ai/v1";

export function normalizeMistralModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return DEFAULT_MISTRAL_EMBEDDING_MODEL;
  }
  if (trimmed.startsWith("mistral/")) {
    return trimmed.slice("mistral/".length);
  }
  return trimmed;
}

export async function createMistralEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<{ provider: EmbeddingProvider; client: MistralEmbeddingClient }> {
  const client = await resolveMistralEmbeddingClient(options);
  const url = `${client.baseUrl.replace(/\/$/, "")}/embeddings`;

  const embed = async (input: string[]): Promise<number[][]> => {
    if (input.length === 0) {
      return [];
    }
    return await fetchRemoteEmbeddingVectors({
      url,
      headers: client.headers,
      ssrfPolicy: client.ssrfPolicy,
      body: { model: client.model, input },
      errorPrefix: "mistral embeddings failed",
    });
  };

  return {
    provider: {
      id: "mistral",
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

export async function resolveMistralEmbeddingClient(
  options: EmbeddingProviderOptions,
): Promise<MistralEmbeddingClient> {
  const { baseUrl, headers, ssrfPolicy } = await resolveRemoteEmbeddingBearerClient({
    provider: "mistral",
    options,
    defaultBaseUrl: DEFAULT_MISTRAL_BASE_URL,
  });
  const model = normalizeMistralModel(options.model);
  return { baseUrl, headers, ssrfPolicy, model };
}
