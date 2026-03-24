import { Buffer } from "node:buffer";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import { loadConfig } from "../config/config.js";
import { logWarn } from "../logger.js";
import {
  createEmbeddingProvider,
  type EmbeddingProviderOptions,
  type EmbeddingProviderRequest,
} from "../memory/embeddings.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendJson } from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";
import { resolveAgentIdFromHeader } from "./http-utils.js";

type OpenAiEmbeddingsHttpOptions = {
  auth: ResolvedGatewayAuth;
  maxBodyBytes?: number;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
};

type EmbeddingsRequest = {
  model?: unknown;
  input?: unknown;
  encoding_format?: unknown;
  dimensions?: unknown;
  user?: unknown;
};

const DEFAULT_EMBEDDINGS_BODY_BYTES = 5 * 1024 * 1024;
const SUPPORTED_EMBEDDING_PROVIDERS = new Set<EmbeddingProviderRequest>([
  "openai",
  "local",
  "gemini",
  "voyage",
  "mistral",
  "ollama",
  "auto",
]);

function coerceRequest(value: unknown): EmbeddingsRequest {
  return value && typeof value === "object" ? (value as EmbeddingsRequest) : {};
}

function resolveInputTexts(input: unknown): string[] | null {
  if (typeof input === "string") {
    return [input];
  }
  if (!Array.isArray(input)) {
    return null;
  }
  if (input.every((entry) => typeof entry === "string")) {
    return input;
  }
  return null;
}

function encodeEmbeddingBase64(embedding: number[]): string {
  const float32 = Float32Array.from(embedding);
  return Buffer.from(float32.buffer).toString("base64");
}

function inferProviderAndModel(params: {
  requestModel: string;
  defaultProvider: EmbeddingProviderRequest;
}): { provider: EmbeddingProviderRequest; model: string } | null {
  const model = params.requestModel.trim();
  if (!model) {
    return null;
  }

  const slash = model.indexOf("/");
  if (slash === -1) {
    return { provider: params.defaultProvider, model };
  }

  const provider = model.slice(0, slash).trim().toLowerCase() as EmbeddingProviderRequest;
  const providerModel = model.slice(slash + 1).trim();
  if (!providerModel || !SUPPORTED_EMBEDDING_PROVIDERS.has(provider)) {
    return null;
  }
  return { provider, model: providerModel };
}

export async function handleOpenAiEmbeddingsHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenAiEmbeddingsHttpOptions,
): Promise<boolean> {
  const handled = await handleGatewayPostJsonEndpoint(req, res, {
    pathname: "/v1/embeddings",
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    maxBodyBytes: opts.maxBodyBytes ?? DEFAULT_EMBEDDINGS_BODY_BYTES,
  });
  if (handled === false) {
    return false;
  }
  if (!handled) {
    return true;
  }

  const payload = coerceRequest(handled.body);
  const requestModel = typeof payload.model === "string" ? payload.model.trim() : "";
  if (!requestModel) {
    sendJson(res, 400, {
      error: { message: "Missing `model`.", type: "invalid_request_error" },
    });
    return true;
  }

  const texts = resolveInputTexts(payload.input);
  if (!texts) {
    sendJson(res, 400, {
      error: {
        message: "`input` must be a string or an array of strings.",
        type: "invalid_request_error",
      },
    });
    return true;
  }

  const cfg = loadConfig();
  const agentId = resolveAgentIdFromHeader(req) ?? "main";
  const agentDir = resolveAgentDir(cfg, agentId);
  const memorySearch = resolveMemorySearchConfig(cfg, agentId);
  const inferred = inferProviderAndModel({
    requestModel,
    defaultProvider: (memorySearch?.provider ?? "openai") as EmbeddingProviderRequest,
  });
  if (!inferred) {
    sendJson(res, 400, {
      error: { message: "Unsupported embedding model reference.", type: "invalid_request_error" },
    });
    return true;
  }

  const options: EmbeddingProviderOptions = {
    config: cfg,
    agentDir,
    provider: inferred.provider,
    model: inferred.model,
    // Public HTTP embeddings should fail closed rather than silently mixing
    // vector spaces across fallback providers/models.
    fallback: "none",
    local: memorySearch?.local,
    remote: memorySearch?.remote
      ? {
          baseUrl: memorySearch.remote.baseUrl,
          apiKey: memorySearch.remote.apiKey,
          headers: memorySearch.remote.headers,
        }
      : undefined,
    outputDimensionality:
      typeof payload.dimensions === "number" && payload.dimensions > 0
        ? Math.floor(payload.dimensions)
        : memorySearch?.outputDimensionality,
  };

  try {
    const result = await createEmbeddingProvider(options);
    if (!result.provider) {
      sendJson(res, 503, {
        error: {
          message: result.providerUnavailableReason ?? "Embeddings provider unavailable.",
          type: "api_error",
        },
      });
      return true;
    }

    const embeddings = await result.provider.embedBatch(texts);
    const encodingFormat = payload.encoding_format === "base64" ? "base64" : "float";

    sendJson(res, 200, {
      object: "list",
      data: embeddings.map((embedding, index) => ({
        object: "embedding",
        index,
        embedding: encodingFormat === "base64" ? encodeEmbeddingBase64(embedding) : embedding,
      })),
      model: requestModel,
      usage: {
        prompt_tokens: 0,
        total_tokens: 0,
      },
    });
  } catch (err) {
    logWarn(`openai-compat: embeddings request failed: ${String(err)}`);
    sendJson(res, 500, {
      error: {
        message: "internal error",
        type: "api_error",
      },
    });
  }

  return true;
}
