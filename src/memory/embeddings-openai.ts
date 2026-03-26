import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { OPENAI_DEFAULT_EMBEDDING_MODEL } from "../plugins/provider-model-defaults.js";
import { debugEmbeddingsLog } from "./embeddings-debug.js";
import { normalizeEmbeddingModelWithPrefixes } from "./embeddings-model-normalize.js";
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
  outputDimensionality?: number;
};

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_OPENAI_EMBEDDING_MODEL = OPENAI_DEFAULT_EMBEDDING_MODEL;
const OPENAI_MAX_INPUT_TOKENS: Record<string, number> = {
  "text-embedding-3-small": 8192,
  "text-embedding-3-large": 8192,
  "text-embedding-ada-002": 8191,
};

// --- text-embedding-3 Matryoshka support ---

const OPENAI_EMBEDDING_3_MODELS = new Set(["text-embedding-3-small", "text-embedding-3-large"]);

const OPENAI_EMBEDDING_3_DEFAULT_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
};

const OPENAI_EMBEDDING_3_VALID_DIMENSIONS: Record<string, readonly number[]> = {
  "text-embedding-3-small": [256, 512, 768, 1024, 1536],
  "text-embedding-3-large": [256, 512, 768, 1024, 1536, 2048, 3072],
};

/**
 * Returns true if given model name is a text-embedding-3 variant that
 * supports `outputDimensionality` (Matryoshka embeddings).
 */
export function isOpenAiEmbedding3Model(model: string): boolean {
  return OPENAI_EMBEDDING_3_MODELS.has(model);
}

/**
 * Validate and return `outputDimensionality` for text-embedding-3 models.
 * Returns `undefined` for older models (they don't support the parameter).
 */
export function resolveOpenAiOutputDimensionality(
  model: string,
  requested?: number,
): number | undefined {
  if (!isOpenAiEmbedding3Model(model)) {
    return undefined;
  }
  if (requested == null) {
    return OPENAI_EMBEDDING_3_DEFAULT_DIMENSIONS[model];
  }
  const valid: readonly number[] = OPENAI_EMBEDDING_3_VALID_DIMENSIONS[model];
  if (!valid.includes(requested)) {
    throw new Error(
      `Invalid outputDimensionality ${requested} for ${model}. Valid values: ${valid.join(", ")}`,
    );
  }
  return requested;
}

export function normalizeOpenAiModel(model: string): string {
  return normalizeEmbeddingModelWithPrefixes({
    model,
    defaultModel: DEFAULT_OPENAI_EMBEDDING_MODEL,
    prefixes: ["openai/"],
  });
}

export async function resolveOpenAiEmbeddingClient(
  options: EmbeddingProviderOptions,
): Promise<OpenAiEmbeddingClient> {
  const client = await resolveRemoteEmbeddingClient({
    provider: "openai",
    options,
    defaultBaseUrl: DEFAULT_OPENAI_BASE_URL,
    normalizeModel: normalizeOpenAiModel,
  });
  const outputDimensionality = resolveOpenAiOutputDimensionality(
    client.model,
    options.outputDimensionality,
  );
  debugEmbeddingsLog("memory embeddings: openai client", {
    baseUrl: client.baseUrl,
    model: client.model,
    outputDimensionality,
  });
  return { ...client, outputDimensionality };
}

export async function createOpenAiEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<{ provider: EmbeddingProvider; client: OpenAiEmbeddingClient }> {
  const client = await resolveOpenAiEmbeddingClient(options);
  const outputDimensionality = client.outputDimensionality;

  return {
    provider: createRemoteEmbeddingProvider({
      id: "openai",
      client,
      outputDimensionality,
      errorPrefix: "openai embeddings failed",
      maxInputTokens: OPENAI_MAX_INPUT_TOKENS[client.model],
    }),
    client,
  };
}
