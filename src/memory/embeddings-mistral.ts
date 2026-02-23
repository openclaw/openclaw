import type { SsrFPolicy } from "../infra/net/ssrf.js";
import {
  createRemoteEmbeddingProvider,
  resolveRemoteEmbeddingClient,
} from "./embeddings-remote-provider.js";
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

  return {
    provider: createRemoteEmbeddingProvider({
      id: "mistral",
      client,
      errorPrefix: "mistral embeddings failed",
    }),
    client,
  };
}

export async function resolveMistralEmbeddingClient(
  options: EmbeddingProviderOptions,
): Promise<MistralEmbeddingClient> {
  return await resolveRemoteEmbeddingClient({
    provider: "mistral",
    options,
    defaultBaseUrl: DEFAULT_MISTRAL_BASE_URL,
    normalizeModel: normalizeMistralModel,
  });
}
