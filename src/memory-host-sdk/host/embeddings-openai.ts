import type { SsrFPolicy } from "../../infra/net/ssrf.js";
import { OPENAI_DEFAULT_EMBEDDING_MODEL } from "../../plugins/provider-model-defaults.js";
import { normalizeEmbeddingModelWithPrefixes } from "./embeddings-model-normalize.js";
import { fetchRemoteEmbeddingVectors } from "./embeddings-remote-fetch.js";
import { resolveRemoteEmbeddingClient } from "./embeddings-remote-provider.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.types.js";

export type OpenAiEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: typeof fetch;
  model: string;
  inputType?: string;
  queryInputType?: string;
  documentInputType?: string;
};

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_OPENAI_EMBEDDING_MODEL = OPENAI_DEFAULT_EMBEDDING_MODEL;
const OPENAI_MAX_INPUT_TOKENS: Record<string, number> = {
  "text-embedding-3-small": 8192,
  "text-embedding-3-large": 8192,
  "text-embedding-ada-002": 8191,
};

export function normalizeOpenAiModel(model: string): string {
  return normalizeEmbeddingModelWithPrefixes({
    model,
    defaultModel: DEFAULT_OPENAI_EMBEDDING_MODEL,
    prefixes: ["openai/"],
  });
}

export async function createOpenAiEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<{ provider: EmbeddingProvider; client: OpenAiEmbeddingClient }> {
  const client = await resolveOpenAiEmbeddingClient(options);
  const url = `${client.baseUrl.replace(/\/$/, "")}/embeddings`;

  const resolveInputType = (kind: "query" | "document"): string | undefined => {
    const explicit = kind === "query" ? client.queryInputType : client.documentInputType;
    const value = explicit ?? client.inputType;
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  };

  const embed = async (input: string[], kind: "query" | "document"): Promise<number[][]> => {
    if (input.length === 0) {
      return [];
    }
    const inputType = resolveInputType(kind);
    const body: { model: string; input: string[]; input_type?: string } = {
      model: client.model,
      input,
    };
    if (inputType) {
      body.input_type = inputType;
    }
    return await fetchRemoteEmbeddingVectors({
      url,
      headers: client.headers,
      ssrfPolicy: client.ssrfPolicy,
      fetchImpl: client.fetchImpl,
      body,
      errorPrefix: "openai embeddings failed",
    });
  };

  return {
    provider: {
      id: "openai",
      model: client.model,
      ...(typeof OPENAI_MAX_INPUT_TOKENS[client.model] === "number"
        ? { maxInputTokens: OPENAI_MAX_INPUT_TOKENS[client.model] }
        : {}),
      embedQuery: async (text) => {
        const [vec] = await embed([text], "query");
        return vec ?? [];
      },
      embedBatch: async (texts) => await embed(texts, "document"),
    },
    client,
  };
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
  return {
    ...client,
    inputType: options.inputType,
    queryInputType: options.queryInputType,
    documentInputType: options.documentInputType,
  };
}
