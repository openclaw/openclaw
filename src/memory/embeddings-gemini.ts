import {
  collectProviderApiKeysForExecution,
  executeWithApiKeyRotation,
} from "../agents/api-key-rotation.js";
import { requireApiKey, resolveApiKeyForProvider } from "../agents/model-auth.js";
import { parseGeminiAuth } from "../infra/gemini-auth.js";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import {
  hasNonTextEmbeddingParts,
  isInlineDataEmbeddingInputPart,
  type EmbeddingInput,
} from "./embedding-inputs.js";
import { sanitizeAndNormalizeEmbedding } from "./embedding-vectors.js";
import { debugEmbeddingsLog } from "./embeddings-debug.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.js";
import { buildRemoteBaseUrlPolicy, withRemoteHttpResponse } from "./remote-http.js";
import { resolveMemorySecretInputString } from "./secret-input.js";

export const GEMINI_EMBEDDING_2_MODELS = new Set(["gemini-embedding-2-preview"]);
const GEMINI_EMBEDDING_2_DIMENSIONS = new Set([768, 1536, 3072]);

export type GeminiTaskType =
  | "RETRIEVAL_QUERY"
  | "RETRIEVAL_DOCUMENT"
  | "SEMANTIC_SIMILARITY"
  | (string & {});

export type GeminiEmbeddingRequestPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

export type GeminiEmbeddingContent = {
  parts: GeminiEmbeddingRequestPart[];
};

export type GeminiTextEmbeddingRequest = {
  model?: string;
  content: GeminiEmbeddingContent;
  taskType?: GeminiTaskType;
  outputDimensionality?: number;
};

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

export function isGeminiEmbedding2Model(model: string): boolean {
  return GEMINI_EMBEDDING_2_MODELS.has(normalizeGeminiModel(model));
}

export function resolveGeminiOutputDimensionality(
  model: string,
  outputDimensionality?: number,
): number | undefined {
  if (!isGeminiEmbedding2Model(model)) {
    return undefined;
  }
  if (typeof outputDimensionality !== "number") {
    return 3072;
  }
  if (!GEMINI_EMBEDDING_2_DIMENSIONS.has(outputDimensionality)) {
    throw new Error(
      `Invalid outputDimensionality ${outputDimensionality} for ${normalizeGeminiModel(model)}. Valid values: 768, 1536, 3072.`,
    );
  }
  return outputDimensionality;
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

export function buildGeminiTextEmbeddingRequest(params: {
  text: string;
  taskType?: GeminiTaskType;
  modelPath?: string;
  outputDimensionality?: number;
}): GeminiTextEmbeddingRequest {
  return {
    ...(params.modelPath ? { model: params.modelPath } : {}),
    content: { parts: [{ text: params.text }] },
    ...(params.taskType ? { taskType: params.taskType } : {}),
    ...(typeof params.outputDimensionality === "number"
      ? { outputDimensionality: params.outputDimensionality }
      : {}),
  };
}

export function buildGeminiEmbeddingRequest(params: {
  input: EmbeddingInput;
  taskType?: GeminiTaskType;
  modelPath?: string;
  outputDimensionality?: number;
}): GeminiTextEmbeddingRequest {
  const parts =
    params.input.parts?.length && hasNonTextEmbeddingParts(params.input)
      ? params.input.parts.map((part) =>
          isInlineDataEmbeddingInputPart(part)
            ? { inlineData: { mimeType: part.mimeType, data: part.data } }
            : { text: part.text },
        )
      : [{ text: params.input.text }];
  return {
    ...(params.modelPath ? { model: params.modelPath } : {}),
    content: { parts },
    ...(params.taskType ? { taskType: params.taskType } : {}),
    ...(typeof params.outputDimensionality === "number"
      ? { outputDimensionality: params.outputDimensionality }
      : {}),
  };
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
        fetchWithGeminiAuth(
          apiKey,
          embedUrl,
          buildGeminiTextEmbeddingRequest({
            text,
            taskType: options.taskType ?? "RETRIEVAL_QUERY",
            modelPath: client.modelPath,
            outputDimensionality: client.outputDimensionality,
          }),
        ),
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
        taskType: "RETRIEVAL_DOCUMENT",
        modelPath: client.modelPath,
        outputDimensionality: client.outputDimensionality,
      }),
    );
    const payload = await executeWithApiKeyRotation({
      provider: "google",
      apiKeys: client.apiKeys,
      execute: (apiKey) =>
        fetchWithGeminiAuth(apiKey, batchUrl, {
          requests,
        }),
    });
    const embeddings = Array.isArray(payload.embeddings) ? payload.embeddings : [];
    return texts.map((_, index) => sanitizeAndNormalizeEmbedding(embeddings[index]?.values ?? []));
  };

  const embedBatchInputs = async (inputs: EmbeddingInput[]): Promise<number[][]> => {
    if (inputs.length === 0) {
      return [];
    }
    const requests = inputs.map((input) =>
      buildGeminiEmbeddingRequest({
        input,
        taskType: "RETRIEVAL_DOCUMENT",
        modelPath: client.modelPath,
        outputDimensionality: client.outputDimensionality,
      }),
    );
    const payload = await executeWithApiKeyRotation({
      provider: "google",
      apiKeys: client.apiKeys,
      execute: (apiKey) =>
        fetchWithGeminiAuth(apiKey, batchUrl, {
          requests,
        }),
    });
    const embeddings = Array.isArray(payload.embeddings) ? payload.embeddings : [];
    return inputs.map((_, index) => sanitizeAndNormalizeEmbedding(embeddings[index]?.values ?? []));
  };

  return {
    provider: {
      id: "gemini",
      model: client.model,
      maxInputTokens: GEMINI_MAX_INPUT_TOKENS[client.model],
      embedQuery,
      embedBatch,
      embedBatchInputs,
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
