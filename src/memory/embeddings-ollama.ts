import { resolveEnvApiKey } from "../agents/model-auth.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
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
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

function sanitizeAndNormalizeEmbedding(vec: number[]): number[] {
  const sanitized = vec.map((value) => (Number.isFinite(value) ? value : 0));
  const magnitude = Math.sqrt(sanitized.reduce((sum, value) => sum + value * value, 0));
  if (magnitude < 1e-10) {
    return sanitized;
  }
  return sanitized.map((value) => value / magnitude);
}

function normalizeOllamaModel(model: string): string {
  return normalizeEmbeddingModelWithPrefixes({
    model,
    defaultModel: DEFAULT_OLLAMA_EMBEDDING_MODEL,
    prefixes: ["ollama/"],
  });
}

function resolveOllamaApiBase(configuredBaseUrl?: string): string {
  if (!configuredBaseUrl) {
    return DEFAULT_OLLAMA_BASE_URL;
  }
  const trimmed = configuredBaseUrl.replace(/\/+$/, "");
  return trimmed.replace(/\/v1$/i, "");
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
  const embedUrl = `${client.baseUrl.replace(/\/$/, "")}/api/embeddings`;

  const embedOne = async (text: string): Promise<number[]> => {
    const json = await withRemoteHttpResponse({
      url: embedUrl,
      ssrfPolicy: client.ssrfPolicy,
      init: {
        method: "POST",
        headers: client.headers,
        body: JSON.stringify({ model: client.model, prompt: text }),
      },
      onResponse: async (res) => {
        if (!res.ok) {
          throw new Error(`Ollama embeddings HTTP ${res.status}: ${await res.text()}`);
        }
        return (await res.json()) as { embedding?: number[] };
      },
    });
    if (!Array.isArray(json.embedding)) {
      throw new Error(`Ollama embeddings response missing embedding[]`);
    }
    return sanitizeAndNormalizeEmbedding(json.embedding);
  };

  const provider: EmbeddingProvider = {
    id: "ollama",
    model: client.model,
    embedQuery: embedOne,
    embedBatch: async (texts: string[]) => {
      // Ollama /api/embeddings accepts one prompt per request.
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
