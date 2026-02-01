import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.js";
import { resolveRemoteEmbeddingBearerClient } from "./embeddings-remote-client.js";
import { fetchRemoteEmbeddingVectors } from "./embeddings-remote-fetch.js";

export type OpenAiEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  model: string;
  queryModel?: string;
};

export const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_MAX_INPUT_TOKENS: Record<string, number> = {
  "text-embedding-3-small": 8192,
  "text-embedding-3-large": 8192,
  "text-embedding-ada-002": 8191,
};

type OpenAiEmbeddingInputType = "query" | "document";

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
  const url = `${client.baseUrl.replace(/\/$/, "")}/embeddings`;

  const embed = async (
    input: string[],
    params?: { model?: string; inputType?: OpenAiEmbeddingInputType },
  ): Promise<number[][]> => {
    if (input.length === 0) {
      return [];
    }
    const body: {
      model: string;
      input: string[];
      input_type?: OpenAiEmbeddingInputType;
    } = {
      model: params?.model ?? client.model,
      input,
    };
    if (params?.inputType) {
      body.input_type = params.inputType;
    }
    return await fetchRemoteEmbeddingVectors({
      url,
      headers: client.headers,
      body,
      errorPrefix: "openai embeddings failed",
    });
  };

  return {
    provider: {
      id: "openai",
      model: client.model,
      maxInputTokens: OPENAI_MAX_INPUT_TOKENS[client.model],
      embedQuery: async (text) => {
        const [vec] = await (client.queryModel
          ? embed([text], { model: client.queryModel, inputType: "query" })
          : embed([text]));
        return vec ?? [];
      },
      embedBatch: async (texts) =>
        client.queryModel
          ? embed(texts, { model: client.model, inputType: "document" })
          : embed(texts),
    },
    client,
  };
}

export async function resolveOpenAiEmbeddingClient(
  options: EmbeddingProviderOptions,
): Promise<OpenAiEmbeddingClient> {
  const { baseUrl, headers } = await resolveRemoteEmbeddingBearerClient({
    provider: "openai",
    options,
    defaultBaseUrl: DEFAULT_OPENAI_BASE_URL,
  });
  const model = normalizeOpenAiModel(options.model);
  const queryModelRaw = options.queryModel?.trim();
  const queryModel = queryModelRaw ? normalizeOpenAiModel(queryModelRaw) : undefined;
  return { baseUrl, headers, model, queryModel };
}
