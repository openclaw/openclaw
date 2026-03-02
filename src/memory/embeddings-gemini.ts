import {
  collectProviderApiKeysForExecution,
  executeWithApiKeyRotation,
} from "../agents/api-key-rotation.js";
import { requireApiKey, resolveApiKeyForProvider } from "../agents/model-auth.js";
import { parseGeminiAuth } from "../infra/gemini-auth.js";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { debugEmbeddingsLog } from "./embeddings-debug.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.js";
import { buildRemoteBaseUrlPolicy, withRemoteHttpResponse } from "./remote-http.js";

export type GeminiEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  model: string;
  modelPath: string;
  apiKeys: string[];
};

const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
export const DEFAULT_GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";
const GEMINI_MAX_INPUT_TOKENS: Record<string, number> = {
  "text-embedding-004": 2048,
};
function resolveRemoteApiKey(remoteApiKey?: string): string | undefined {
  const trimmed = remoteApiKey?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "GOOGLE_API_KEY" || trimmed === "GEMINI_API_KEY") {
    return process.env[trimmed]?.trim();
  }
  return trimmed;
}

function normalizeGeminiModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return DEFAULT_GEMINI_EMBEDDING_MODEL;
  }
  const withoutPrefix = trimmed.replace(/^models\//, "");
  if (withoutPrefix.startsWith("gemini/")) {
    return withoutPrefix.slice("gemini/".length);
  }
  if (withoutPrefix.startsWith("google/")) {
    return withoutPrefix.slice("google/".length);
  }
  return withoutPrefix;
}

function normalizeGeminiBaseUrl(raw: string): string {
  const trimmed = raw.replace(/\/+$/, "");
  const openAiIndex = trimmed.indexOf("/openai");
  if (openAiIndex > -1) {
    return trimmed.slice(0, openAiIndex);
  }
  return trimmed;
}

function buildGeminiModelPath(model: string): string {
  return model.startsWith("models/") ? model : `models/${model}`;
}

export async function createGeminiEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<{ provider: EmbeddingProvider; client: GeminiEmbeddingClient }> {
  const client = await resolveGeminiEmbeddingClient(options);
  const baseUrl = client.baseUrl.replace(/\/$/, "");
  const embedUrl = `${baseUrl}/${client.modelPath}:embedContent`;
  const batchUrl = `${baseUrl}/${client.modelPath}:batchEmbedContents`;

  const fetchWithGeminiAuth = async (apiKey: string, endpoint: string, body: unknown) => {
    const authHeaders = parseGeminiAuth(apiKey);
    const headers = {
      ...authHeaders.headers,
      ...client.headers,
    };
    const payload = await withRemoteHttpResponse({
      url: endpoint,
      ssrfPolicy: client.ssrfPolicy,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
      onResponse: async (res) => {
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`gemini embeddings failed: ${res.status} ${text}`);
        }
        return (await res.json()) as {
          embedding?: { values?: number[] };
          embeddings?: Array<{ values?: number[] }>;
        };
      },
    });
    return payload;
  };

  const embedQuery = async (text: string): Promise<number[]> => {
    if (!text.trim()) {
      return [];
    }
    const payload = await executeWithApiKeyRotation({
      provider: "google",
      apiKeys: client.apiKeys,
      execute: (apiKey) =>
        fetchWithGeminiAuth(apiKey, embedUrl, {
          content: { parts: [{ text }] },
          taskType: "RETRIEVAL_QUERY",
        }),
    });
    return payload.embedding?.values ?? [];
  };

  const embedBatch = async (texts: string[]): Promise<number[][]> => {
    if (texts.length === 0) {
      return [];
    }
    const requests = texts.map((text) => ({
      model: client.modelPath,
      content: { parts: [{ text }] },
      taskType: "RETRIEVAL_DOCUMENT",
    }));
    const payload = await executeWithApiKeyRotation({
      provider: "google",
      apiKeys: client.apiKeys,
      execute: (apiKey) =>
        fetchWithGeminiAuth(apiKey, batchUrl, {
          requests,
        }),
    });
    const embeddings = Array.isArray(payload.embeddings) ? payload.embeddings : [];
    return texts.map((_, index) => embeddings[index]?.values ?? []);
  };

  return {
    provider: {
      id: "gemini",
      model: client.model,
      maxInputTokens: GEMINI_MAX_INPUT_TOKENS[client.model],
      embedQuery,
      embedBatch,
    },
    client,
  };
}

export async function resolveGeminiEmbeddingClient(
  options: EmbeddingProviderOptions,
): Promise<GeminiEmbeddingClient> {
  const remote = options.remote;
  const remoteApiKey = resolveRemoteApiKey(remote?.apiKey);
  const remoteBaseUrl = remote?.baseUrl?.trim();

  const apiKey = remoteApiKey
    ? remoteApiKey
    : requireApiKey(
        await resolveApiKeyForProvider({
          provider: "google",
          cfg: options.config,
          agentDir: options.agentDir,
        }),
        "google",
      );

  const providerConfig = options.config.models?.providers?.google;
  const rawBaseUrl = remoteBaseUrl || providerConfig?.baseUrl?.trim() || DEFAULT_GEMINI_BASE_URL;
  const baseUrl = normalizeGeminiBaseUrl(rawBaseUrl);
  const ssrfPolicy = buildRemoteBaseUrlPolicy(baseUrl);
  const headerOverrides = Object.assign({}, providerConfig?.headers, remote?.headers);
  const headers: Record<string, string> = {
    ...headerOverrides,
  };
  const apiKeys = collectProviderApiKeysForExecution({
    provider: "google",
    primaryApiKey: apiKey,
  });
  const model = normalizeGeminiModel(options.model);
  const modelPath = buildGeminiModelPath(model);
  debugEmbeddingsLog("memory embeddings: gemini client", {
    rawBaseUrl,
    baseUrl,
    model,
    modelPath,
    embedEndpoint: `${baseUrl}/${modelPath}:embedContent`,
    batchEndpoint: `${baseUrl}/${modelPath}:batchEmbedContents`,
  });
  return { baseUrl, headers, ssrfPolicy, model, modelPath, apiKeys };
}
