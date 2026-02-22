import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.js";

// ---------------------------------------------------------------------------
// Model registry — add new Bedrock embedding models here as they become GA
// ---------------------------------------------------------------------------

type BedrockModelConfig = {
  maxInputChars: number;
  defaultDimension: number;
  buildRequest: (text: string, dimension: number) => unknown;
  parseResponse: (body: unknown) => number[];
};

function buildNova2Request(text: string, dimension: number): unknown {
  return {
    schemaVersion: "nova-multimodal-embed-v1",
    taskType: "SINGLE_EMBEDDING",
    singleEmbeddingParams: {
      embeddingPurpose: "GENERIC_INDEX",
      embeddingDimension: dimension,
      text: {
        truncationMode: "END",
        value: text,
      },
    },
  };
}

function parseNova2Response(body: unknown): number[] {
  const payload = body as { embeddings?: Array<{ embedding?: number[] }> };
  return payload.embeddings?.[0]?.embedding ?? [];
}

const BEDROCK_MODEL_REGISTRY: Record<string, BedrockModelConfig> = {
  "amazon.nova-2-multimodal-embeddings-v1:0": {
    maxInputChars: 8192,
    defaultDimension: 1024,
    buildRequest: buildNova2Request,
    parseResponse: parseNova2Response,
  },
};

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

export const DEFAULT_BEDROCK_EMBEDDING_MODEL = "amazon.nova-2-multimodal-embeddings-v1:0";
export const DEFAULT_BEDROCK_REGION = "us-east-1";

export type BedrockEmbeddingClient = {
  baseUrl: string;
  modelId: string;
  headers: Record<string, string>;
  region: string | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function normalizeBedrockModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return DEFAULT_BEDROCK_EMBEDDING_MODEL;
  }
  if (trimmed.startsWith("bedrock/")) {
    return trimmed.slice("bedrock/".length);
  }
  return trimmed;
}

function resolveBedrockBearerToken(options: EmbeddingProviderOptions): string {
  const remoteKey = options.remote?.apiKey?.trim();
  if (remoteKey) {
    return remoteKey;
  }

  const envToken = process.env.AWS_BEARER_TOKEN_BEDROCK?.trim();
  if (envToken) {
    return envToken;
  }

  throw new Error(
    [
      'No API key found for provider "bedrock".',
      "Set AWS_BEARER_TOKEN_BEDROCK in your environment.",
      "Obtain a token via IAM Identity Center (SSO): aws sso login",
      "Note: bearer tokens expire (typically 1h); re-run aws sso login to refresh.",
    ].join("\n"),
  );
}

function resolveBedrockRegion(options: EmbeddingProviderOptions): string {
  const providerCfg = options.config.models?.providers?.["amazon-bedrock"] as
    | { region?: string }
    | undefined;
  return (
    providerCfg?.region?.trim() ||
    process.env.AWS_REGION?.trim() ||
    process.env.AWS_DEFAULT_REGION?.trim() ||
    DEFAULT_BEDROCK_REGION
  );
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

export async function createBedrockEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<{ provider: EmbeddingProvider; client: BedrockEmbeddingClient }> {
  const modelId = normalizeBedrockModel(options.model);
  const modelConfig = BEDROCK_MODEL_REGISTRY[modelId];

  if (!modelConfig) {
    const supported = Object.keys(BEDROCK_MODEL_REGISTRY).join(", ");
    throw new Error(
      `Unsupported Bedrock embedding model: "${modelId}". Supported models: ${supported}`,
    );
  }

  // Validate token exists at startup (fail fast), but don't capture the value —
  // it will be re-read at request time so `aws sso login` refreshes are picked up
  // without restarting the process.
  resolveBedrockBearerToken(options);

  const remoteBaseUrl = options.remote?.baseUrl?.trim();
  const region = remoteBaseUrl ? null : resolveBedrockRegion(options);
  const baseUrl = remoteBaseUrl || `https://bedrock-runtime.${region}.amazonaws.com`;

  const providerCfg = options.config.models?.providers?.["amazon-bedrock"] as
    | { headers?: Record<string, string> }
    | undefined;
  const staticHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...providerCfg?.headers,
    ...options.remote?.headers,
  };

  const client: BedrockEmbeddingClient = { baseUrl, modelId, headers: staticHeaders, region };

  const invokeUrl = `${baseUrl}/model/${encodeURIComponent(modelId)}/invoke`;
  const { defaultDimension, buildRequest, parseResponse } = modelConfig;

  const embedSingle = async (text: string): Promise<number[]> => {
    const body = buildRequest(text, defaultDimension);
    const liveToken = resolveBedrockBearerToken(options);
    const res = await fetch(invokeUrl, {
      method: "POST",
      headers: { ...staticHeaders, Authorization: `Bearer ${liveToken}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`bedrock embeddings failed: ${res.status} ${errText}`);
    }
    const payload = await res.json();
    return parseResponse(payload);
  };

  return {
    provider: {
      id: "bedrock",
      model: modelId,
      embedQuery: embedSingle,
      embedBatch: (texts) => Promise.all(texts.map(embedSingle)),
    },
    client,
  };
}
