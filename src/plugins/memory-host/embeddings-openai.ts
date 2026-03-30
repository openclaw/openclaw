import type { SsrFPolicy } from "../../infra/net/ssrf.js";
import { OPENAI_DEFAULT_EMBEDDING_MODEL } from "../../plugins/provider-model-defaults.js";
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

const OPENAI_EMBEDDING3_SMALL_DIMENSIONS = [256, 512, 768, 1024, 1536] as const;
const OPENAI_EMBEDDING3_LARGE_DIMENSIONS = [256, 512, 768, 1024, 1536, 2048, 3072] as const;

export function normalizeOpenAiModel(model: string): string {
  return normalizeEmbeddingModelWithPrefixes({
    model,
    defaultModel: DEFAULT_OPENAI_EMBEDDING_MODEL,
    prefixes: ["openai/"],
  });
}

export function isOpenAiEmbedding3Model(model: string): boolean {
  return model === "text-embedding-3-small" || model === "text-embedding-3-large";
}

export function resolveOpenAiOutputDimensionality(
  model: string,
  dimensionality: number | undefined,
): number | undefined {
  if (!isOpenAiEmbedding3Model(model)) {
    return undefined;
  }

  if (dimensionality === undefined) {
    // Return undefined to omit dimensions field from request,
    // letting OpenAI use its own default
    return undefined;
  }

  const validDimensions =
    model === "text-embedding-3-small"
      ? (OPENAI_EMBEDDING3_SMALL_DIMENSIONS as readonly number[])
      : (OPENAI_EMBEDDING3_LARGE_DIMENSIONS as readonly number[]);

  if (!validDimensions.includes(dimensionality)) {
    throw new Error(
      `Invalid output dimensionality ${dimensionality} for ${model}. ` +
        `Supported dimensions: ${validDimensions.join(", ")}`,
    );
  }

  return dimensionality;
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
  const model = normalizeOpenAiModel(options.model);
  const outputDimensionality = resolveOpenAiOutputDimensionality(
    model,
    options.outputDimensionality,
  );
  return await resolveRemoteEmbeddingClient({
    provider: "openai",
    options,
    defaultBaseUrl: DEFAULT_OPENAI_BASE_URL,
    normalizeModel: normalizeOpenAiModel,
    outputDimensionality,
  });
}
