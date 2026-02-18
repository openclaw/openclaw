import type { EmbeddingProvider } from "./embeddings.js";

const DEFAULT_EMBEDDING_MAX_INPUT_TOKENS = 8192;

const KNOWN_EMBEDDING_MAX_INPUT_TOKENS: Record<string, number> = {
  "openai:text-embedding-3-small": 8192,
  "openai:text-embedding-3-large": 8192,
  "openai:text-embedding-ada-002": 8191,
  "gemini:text-embedding-004": 2048,
  "voyage:voyage-3": 32000,
  "voyage:voyage-3-lite": 16000,
  "voyage:voyage-code-3": 32000,
};

export function resolveEmbeddingMaxInputTokens(provider: EmbeddingProvider): number {
  if (typeof provider.maxInputTokens === "number") {
    return provider.maxInputTokens;
  }

  // Provider/model mapping is best-effort; different providers use different
  // limits and we prefer to be conservative when we don't know.
  const key = `${provider.id}:${provider.model}`.toLowerCase();
  const known = KNOWN_EMBEDDING_MAX_INPUT_TOKENS[key];
  if (typeof known === "number") {
    return known;
  }

  // Provider-specific conservative fallbacks. This prevents us from accidentally
  // using the OpenAI default for providers with much smaller limits.
  if (provider.id.toLowerCase() === "gemini") {
    return 2048;
  }

  return DEFAULT_EMBEDDING_MAX_INPUT_TOKENS;
}
