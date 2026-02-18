import { resolveRemoteEmbeddingBearerClient } from "./embeddings-remote-client.js";
import { fetchRemoteEmbeddingVectors } from "./embeddings-remote-fetch.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.js";

export type TelnyxEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  model: string;
};

export const DEFAULT_TELNYX_EMBEDDING_MODEL = "thenlper/gte-large";
const DEFAULT_TELNYX_BASE_URL = "https://api.telnyx.com/v2/ai/openai";

export function normalizeTelnyxModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return DEFAULT_TELNYX_EMBEDDING_MODEL;
  }
  if (trimmed.startsWith("telnyx/")) {
    return trimmed.slice("telnyx/".length);
  }
  return trimmed;
}

export async function createTelnyxEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<{ provider: EmbeddingProvider; client: TelnyxEmbeddingClient }> {
  const client = await resolveTelnyxEmbeddingClient(options);
  const url = `${client.baseUrl.replace(/\/$/, "")}/embeddings`;

  const embed = async (input: string[]): Promise<number[][]> => {
    if (input.length === 0) {
      return [];
    }
    const body = {
      model: client.model,
      input,
    };

    return await fetchRemoteEmbeddingVectors({
      url,
      headers: client.headers,
      body,
      errorPrefix: "telnyx embeddings failed",
    });
  };

  return {
    provider: {
      id: "telnyx",
      model: client.model,
      // maxInputTokens resolved from KNOWN_EMBEDDING_MAX_INPUT_TOKENS
      // in embedding-model-limits.ts (single source of truth)
      embedQuery: async (text) => {
        const [vec] = await embed([text]);
        return vec ?? [];
      },
      embedBatch: async (texts) => embed(texts),
    },
    client,
  };
}

export async function resolveTelnyxEmbeddingClient(
  options: EmbeddingProviderOptions,
): Promise<TelnyxEmbeddingClient> {
  const { baseUrl, headers } = await resolveRemoteEmbeddingBearerClient({
    provider: "telnyx",
    options,
    defaultBaseUrl: DEFAULT_TELNYX_BASE_URL,
  });
  const model = normalizeTelnyxModel(options.model);
  return { baseUrl, headers, model };
}
