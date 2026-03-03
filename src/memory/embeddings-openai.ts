import type { SsrFPolicy } from "../infra/net/ssrf.js";
import {
  createRemoteEmbeddingProvider,
  resolveRemoteEmbeddingClient,
} from "./embeddings-remote-provider.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.js";

export type OpenAiEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  model: string;
};

export const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_MAX_INPUT_TOKENS: Record<string, number> = {
  "text-embedding-3-small": 8192,
  "text-embedding-3-large": 8192,
  "text-embedding-ada-002": 8191,
};

export function normalizeOpenAiModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return DEFAULT_OPENAI_EMBEDDING_MODEL;
  }
  if (trimmed.startsWith("openai/")) {
    return trimmed.slice("openai/".length);
  }
  return trimmed;
}

export async function createOpenAiEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<{ provider: EmbeddingProvider; client: OpenAiEmbeddingClient }> {
  const client = await resolveOpenAiEmbeddingClient(options);

  return {
    provider: createRemoteEmbeddingProvider({
      id: "openai",
      client,
      errorPrefix: "openai embeddings failed",
      maxInputTokens: OPENAI_MAX_INPUT_TOKENS[client.model],
    }),
    client,
  };
}

export async function resolveOpenAiEmbeddingClient(
  options: EmbeddingProviderOptions,
): Promise<OpenAiEmbeddingClient> {
  return await resolveRemoteEmbeddingClient({
    provider: "openai",
    options,
    defaultBaseUrl: DEFAULT_OPENAI_BASE_URL,
    normalizeModel: normalizeOpenAiModel,
  });
}
