import { resolveRemoteEmbeddingBearerClient } from "./embeddings-remote-client.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.js";

export type MistralEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
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
    const res = await fetch(url, {
      method: "POST",
      headers: client.headers,
      body: JSON.stringify({ model: client.model, input }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`mistral embeddings failed: ${res.status} ${text}`);
    }
    const payload = (await res.json()) as {
      data?: Array<{ embedding?: number[] }>;
      error?: { message?: string };
    };
    if (payload.error?.message) {
      throw new Error(`mistral embeddings failed: ${payload.error.message}`);
    }
    const data = payload.data ?? [];
    return data.map((entry) => entry.embedding ?? []);
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
  const { baseUrl, headers } = await resolveRemoteEmbeddingBearerClient({
    provider: "mistral",
    options,
    defaultBaseUrl: DEFAULT_MISTRAL_BASE_URL,
  });
  const model = normalizeMistralModel(options.model);
  return { baseUrl, headers, model };
}
