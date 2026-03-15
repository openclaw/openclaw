import { resolveEnvApiKey } from "../agents/model-auth.js";
import { resolveOllamaApiBase } from "../agents/ollama-models.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
import { sanitizeAndNormalizeEmbedding } from "./embedding-vectors.js";
import { normalizeEmbeddingModelWithPrefixes } from "./embeddings-model-normalize.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.js";
import { buildRemoteBaseUrlPolicy, withRemoteHttpResponse } from "./remote-http.js";
import { resolveMemorySecretInputString } from "./secret-input.js";

export type OllamaEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  model: string;
  embedBatch: (texts: string[]) => Promise<number[][]>;
};
type OllamaEmbeddingClientConfig = Omit<OllamaEmbeddingClient, "embedBatch">;

export const DEFAULT_OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";

function normalizeOllamaModel(model: string): string {
  return normalizeEmbeddingModelWithPrefixes({
    model,
    defaultModel: DEFAULT_OLLAMA_EMBEDDING_MODEL,
    prefixes: ["ollama/"],
  });
}

function resolveOllamaApiKey(options: EmbeddingProviderOptions): string | undefined {
  const remoteApiKey = resolveMemorySecretInputString({
    value: options.remote?.apiKey,
    path: "agents.*.memorySearch.remote.apiKey",
  });
  if (remoteApiKey) {
    return remoteApiKey;
  }
  const providerApiKey = normalizeOptionalSecretInput(
    options.config.models?.providers?.ollama?.apiKey,
  );
  if (providerApiKey) {
    return providerApiKey;
  }
  return resolveEnvApiKey("ollama")?.apiKey;
}

function resolveOllamaEmbeddingClient(
  options: EmbeddingProviderOptions,
): OllamaEmbeddingClientConfig {
  const providerConfig = options.config.models?.providers?.ollama;
  const rawBaseUrl = options.remote?.baseUrl?.trim() || providerConfig?.baseUrl?.trim();
  const baseUrl = resolveOllamaApiBase(rawBaseUrl);
  const model = normalizeOllamaModel(options.model);
  const headerOverrides = Object.assign({}, providerConfig?.headers, options.remote?.headers);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...headerOverrides,
  };
  const apiKey = resolveOllamaApiKey(options);
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return {
    baseUrl,
    headers,
    ssrfPolicy: buildRemoteBaseUrlPolicy(baseUrl),
    model,
  };
}

export async function createOllamaEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<{ provider: EmbeddingProvider; client: OllamaEmbeddingClient }> {
  const client = resolveOllamaEmbeddingClient(options);
  const embedUrl = `${client.baseUrl.replace(/\/$/, "")}/api/embed`;

  const embedOne = async (text: string): Promise<number[]> => {
    const embedding = await withRemoteHttpResponse({
      url: embedUrl,
      ssrfPolicy: client.ssrfPolicy,
      init: {
        method: "POST",
        headers: client.headers,
        body: JSON.stringify({ model: client.model, input: text }),
      },
      onResponse: async (res) => {
        if (!res.ok) {
          throw new Error(`Ollama embeddings HTTP ${res.status}: ${await res.text()}`);
        }
        const json = (await res.json()) as { embeddings?: number[][]; embedding?: number[] };
        // New /api/embed returns { embeddings: [[...]] }, old /api/embeddings returned { embedding: [...] }
        const emb = json.embeddings?.[0] ?? json.embedding;
        if (!Array.isArray(emb)) {
          throw new Error(`Ollama embeddings response missing embedding[]`);
        }
        return emb;
      },
    });
    return sanitizeAndNormalizeEmbedding(embedding);
  };

  const provider: EmbeddingProvider = {
    id: "ollama",
    model: client.model,
    embedQuery: embedOne,
    embedBatch: async (texts: string[]) => {
      // Ollama /api/embed accepts one input per request.
      return await Promise.all(texts.map(embedOne));
    },
  };

  return {
    provider,
    client: {
      ...client,
      embedBatch: async (texts) => {
        try {
          return await provider.embedBatch(texts);
        } catch (err) {
          throw new Error(formatErrorMessage(err), { cause: err });
        }
      },
    },
  };
}
