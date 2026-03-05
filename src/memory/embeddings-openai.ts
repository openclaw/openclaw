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
const DEFAULT_SILICONFLOW_BASE_URL = "https://api.siliconflow.cn/v1";
const OPENAI_MAX_INPUT_TOKENS: Record<string, number> = {
  "text-embedding-3-small": 8192,
  "text-embedding-3-large": 8192,
  "text-embedding-ada-002": 8191,
};

type OpenAiCompatEmbeddingProviderId = "openai" | "siliconflow";

export function normalizeOpenAiModel(
  model: string,
  provider: OpenAiCompatEmbeddingProviderId = "openai",
): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return DEFAULT_OPENAI_EMBEDDING_MODEL;
  }
  const prefix = `${provider}/`;
  if (trimmed.startsWith(prefix)) {
    return trimmed.slice(prefix.length);
  }
  if (provider !== "openai" && trimmed.startsWith("openai/")) {
    return trimmed.slice("openai/".length);
  }
  return trimmed;
}

export async function createOpenAiEmbeddingProvider(
  options: EmbeddingProviderOptions,
  provider: OpenAiCompatEmbeddingProviderId = "openai",
): Promise<{ provider: EmbeddingProvider; client: OpenAiEmbeddingClient }> {
  const client = await resolveOpenAiEmbeddingClient(options, provider);

  return {
    provider: createRemoteEmbeddingProvider({
      id: provider,
      client,
      errorPrefix: `${provider} embeddings failed`,
      maxInputTokens: OPENAI_MAX_INPUT_TOKENS[client.model],
    }),
    client,
  };
}

export async function resolveOpenAiEmbeddingClient(
  options: EmbeddingProviderOptions,
  provider: OpenAiCompatEmbeddingProviderId = "openai",
): Promise<OpenAiEmbeddingClient> {
  const defaultBaseUrl =
    provider === "siliconflow" ? DEFAULT_SILICONFLOW_BASE_URL : DEFAULT_OPENAI_BASE_URL;
  return await resolveRemoteEmbeddingClient({
    provider,
    options,
    defaultBaseUrl,
    normalizeModel: (model) => normalizeOpenAiModel(model, provider),
  });
}
