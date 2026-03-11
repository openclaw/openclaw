import {
  collectProviderApiKeysForExecution,
  executeWithApiKeyRotation,
} from "../agents/api-key-rotation.js";
import { requireApiKey, resolveApiKeyForProvider } from "../agents/model-auth.js";
import { parseGeminiAuth } from "../infra/gemini-auth.js";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { sanitizeAndNormalizeEmbedding } from "./embedding-vectors.js";
import { debugEmbeddingsLog } from "./embeddings-debug.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.js";
import { buildRemoteBaseUrlPolicy, withRemoteHttpResponse } from "./remote-http.js";
import { resolveMemorySecretInputString } from "./secret-input.js";

export type GeminiEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  model: string;
  modelPath: string;
  apiKeys: string[];
  outputDimensionality?: number;
};

const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
export const DEFAULT_GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";
const GEMINI_MAX_INPUT_TOKENS: Record<string, number> = {
  "text-embedding-004": 2048,
};

// --- gemini-embedding-2-preview support ---

export const GEMINI_EMBEDDING_2_MODELS = new Set([
  "gemini-embedding-2-preview",
  // Add the GA model name here once released.
]);

const GEMINI_EMBEDDING_2_DEFAULT_DIMENSIONS = 3072;
const GEMINI_EMBEDDING_2_VALID_DIMENSIONS = [768, 1536, 3072] as const;

export type GeminiTaskType =
  | "RETRIEVAL_QUERY"
  | "RETRIEVAL_DOCUMENT"
  | "SEMANTIC_SIMILARITY"
  | "CLASSIFICATION"
  | "CLUSTERING"
  | "QUESTION_ANSWERING"
  | "FACT_VERIFICATION";

export type GeminiTextPart = { text: string };
export type GeminiInlinePart = {
  inlineData: { mimeType: string; data: string };
};
export type GeminiFilePart = {
  fileData: { mimeType: string; fileUri: string };
};
export type GeminiPart = GeminiTextPart | GeminiInlinePart | GeminiFilePart;
export type GeminiTextEmbeddingRequest = {
  content: { parts: GeminiTextPart[] };
  taskType: GeminiTaskType;
  outputDimensionality?: number;
  model?: string;
};

/** Convert a string or pre-built parts array into `GeminiPart[]`. */
export function buildGeminiParts(input: string | GeminiPart[]): GeminiPart[] {
  if (typeof input === "string") {
    return [{ text: input }];
  }
  return input;
}

/** Convenience: build an inline-data part for multimodal embeddings. */
export function buildInlineDataPart(mimeType: string, base64Data: string): GeminiInlinePart {
  return { inlineData: { mimeType, data: base64Data } };
}

/** Convenience: build a file-data part for multimodal embeddings. */
export function buildFileDataPart(mimeType: string, fileUri: string): GeminiFilePart {
  return { fileData: { mimeType, fileUri } };
}

/** Builds the text-only Gemini embedding request shape used across direct and batch APIs. */
export function buildGeminiTextEmbeddingRequest(params: {
  text: string;
  taskType: GeminiTaskType;
  outputDimensionality?: number;
  modelPath?: string;
}): GeminiTextEmbeddingRequest {
  const request: GeminiTextEmbeddingRequest = {
    content: { parts: [{ text: params.text }] },
    taskType: params.taskType,
  };
  if (params.modelPath) {
    request.model = params.modelPath;
  }
  if (params.outputDimensionality != null) {
    request.outputDimensionality = params.outputDimensionality;
  }
  return request;
}

/**
 * Returns true if the given model name is a gemini-embedding-2 variant that
 * supports `outputDimensionality` and extended task types.
 */
export function isGeminiEmbedding2Model(model: string): boolean {
  return GEMINI_EMBEDDING_2_MODELS.has(model);
}

/**
 * Validate and return the `outputDimensionality` for gemini-embedding-2 models.
 * Returns `undefined` for older models (they don't support the param).
 */
export function resolveGeminiOutputDimensionality(
  model: string,
  requested?: number,
): number | undefined {
  if (!isGeminiEmbedding2Model(model)) {
    return undefined;
  }
  if (requested == null) {
    return GEMINI_EMBEDDING_2_DEFAULT_DIMENSIONS;
  }
  const valid: readonly number[] = GEMINI_EMBEDDING_2_VALID_DIMENSIONS;
  if (!valid.includes(requested)) {
    throw new Error(
      `Invalid outputDimensionality ${requested} for ${model}. Valid values: ${valid.join(", ")}`,
    );
  }
  return requested;
}
function resolveRemoteApiKey(remoteApiKey: unknown): string | undefined {
  const trimmed = resolveMemorySecretInputString({
    value: remoteApiKey,
    path: "agents.*.memorySearch.remote.apiKey",
  });
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
  const isV2 = isGeminiEmbedding2Model(client.model);
  const outputDimensionality = client.outputDimensionality;

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
    const body = buildGeminiTextEmbeddingRequest({
      text,
      taskType: options.taskType ?? "RETRIEVAL_QUERY",
      outputDimensionality: isV2 ? outputDimensionality : undefined,
    });
    const payload = await executeWithApiKeyRotation({
      provider: "google",
      apiKeys: client.apiKeys,
      execute: (apiKey) => fetchWithGeminiAuth(apiKey, embedUrl, body),
    });
    return sanitizeAndNormalizeEmbedding(payload.embedding?.values ?? []);
  };

  const embedBatch = async (texts: string[]): Promise<number[][]> => {
    if (texts.length === 0) {
      return [];
    }
    const requests = texts.map((text) =>
      buildGeminiTextEmbeddingRequest({
        text,
        modelPath: client.modelPath,
        taskType: options.taskType ?? "RETRIEVAL_DOCUMENT",
        outputDimensionality: isV2 ? outputDimensionality : undefined,
      }),
    );
    const batchBody = { requests };
    const payload = await executeWithApiKeyRotation({
      provider: "google",
      apiKeys: client.apiKeys,
      execute: (apiKey) => fetchWithGeminiAuth(apiKey, batchUrl, batchBody),
    });
    const embeddings = Array.isArray(payload.embeddings) ? payload.embeddings : [];
    return texts.map((_, index) => sanitizeAndNormalizeEmbedding(embeddings[index]?.values ?? []));
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
  const outputDimensionality = resolveGeminiOutputDimensionality(
    model,
    options.outputDimensionality,
  );
  debugEmbeddingsLog("memory embeddings: gemini client", {
    rawBaseUrl,
    baseUrl,
    model,
    modelPath,
    outputDimensionality,
    embedEndpoint: `${baseUrl}/${modelPath}:embedContent`,
    batchEndpoint: `${baseUrl}/${modelPath}:batchEmbedContents`,
  });
  return { baseUrl, headers, ssrfPolicy, model, modelPath, apiKeys, outputDimensionality };
}
