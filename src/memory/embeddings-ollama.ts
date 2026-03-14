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
const OLLAMA_EMBED_BATCH_CONCURRENCY = 4;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const capped = Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : 1;
  const workers = Math.min(capped, items.length);
  const out: R[] = [];
  const filled = Array.from({ length: items.length }, () => false);
  let index = 0;
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (true) {
        const current = index;
        index += 1;
        if (current >= items.length) {
          return;
        }
        out[current] = await mapper(items[current], current);
        filled[current] = true;
      }
    }),
  );
  const finalized: R[] = [];
  for (let i = 0; i < filled.length; i += 1) {
    if (!filled[i]) {
      throw new Error("Ollama embedding batch mapping did not fill all results");
    }
    finalized.push(out[i]);
  }
  return finalized;
}

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
      return await mapWithConcurrency(texts, OLLAMA_EMBED_BATCH_CONCURRENCY, embedOne);
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
