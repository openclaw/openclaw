import { Buffer } from "node:buffer";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import { loadConfig } from "../config/config.js";
import { logWarn } from "../logger.js";
import {
  createEmbeddingProvider,
  type EmbeddingProviderOptions,
  type EmbeddingProviderId,
  type EmbeddingProviderRequest,
} from "../memory/embeddings.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendJson } from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";
import {
  OPENCLAW_MODEL_ID,
  getHeader,
  resolveAgentIdForRequest,
  resolveAgentIdFromModel,
} from "./http-utils.js";

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
const MAX_EMBEDDING_INPUTS = 128;
const MAX_EMBEDDING_INPUT_CHARS = 8_192;
const MAX_EMBEDDING_TOTAL_CHARS = 65_536;
const SAFE_AUTO_EXPLICIT_PROVIDERS = new Set<EmbeddingProviderId>([
  "openai",
  "gemini",
  "voyage",
  "mistral",
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

function validateInputTexts(texts: string[]): string | undefined {
  if (texts.length > MAX_EMBEDDING_INPUTS) {
    return `Too many inputs (max ${MAX_EMBEDDING_INPUTS}).`;
  }
  let totalChars = 0;
  for (const text of texts) {
    if (text.length > MAX_EMBEDDING_INPUT_CHARS) {
      return `Input too long (max ${MAX_EMBEDDING_INPUT_CHARS} chars).`;
    }
    totalChars += text.length;
    if (totalChars > MAX_EMBEDDING_TOTAL_CHARS) {
      return `Total input too large (max ${MAX_EMBEDDING_TOTAL_CHARS} chars).`;
    }
  }
  return undefined;
}

function resolveEmbeddingsTarget(params: {
  requestModel: string;
  configuredProvider: EmbeddingProviderRequest;
}): { provider: EmbeddingProviderRequest; model: string } | { errorMessage: string } {
  const raw = params.requestModel.trim();
  const slash = raw.indexOf("/");
  if (slash === -1) {
    return { provider: params.configuredProvider, model: raw };
  }

  const provider = raw.slice(0, slash).trim().toLowerCase() as EmbeddingProviderRequest;
  const model = raw.slice(slash + 1).trim();
  if (!model) {
    return { errorMessage: "Unsupported embedding model reference." };
  }

  if (params.configuredProvider === "auto") {
    if (provider === "auto") {
      return { provider: "auto", model };
    }
    if (SAFE_AUTO_EXPLICIT_PROVIDERS.has(provider)) {
      return { provider, model };
    }
    return {
      errorMessage: "This agent does not allow that embedding provider on `/v1/embeddings`.",
    };
  }

  if (provider !== params.configuredProvider) {
    return {
      errorMessage: "This agent does not allow that embedding provider on `/v1/embeddings`.",
    };
  }

  return { provider: params.configuredProvider, model };
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

  const cfg = loadConfig();
  if (requestModel !== OPENCLAW_MODEL_ID && !resolveAgentIdFromModel(requestModel, cfg)) {
    sendJson(res, 400, {
      error: {
        message: "Invalid `model`. Use `openclaw` or `openclaw/<agentId>`.",
        type: "invalid_request_error",
      },
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
  const inputError = validateInputTexts(texts);
  if (inputError) {
    sendJson(res, 400, {
      error: { message: inputError, type: "invalid_request_error" },
    });
    return true;
  }

  const agentId = resolveAgentIdForRequest({ req, model: requestModel });
  const agentDir = resolveAgentDir(cfg, agentId);
  const memorySearch = resolveMemorySearchConfig(cfg, agentId);
  const configuredProvider = (memorySearch?.provider ?? "openai") as EmbeddingProviderRequest;
  const overrideModel = getHeader(req, "x-openclaw-model")?.trim() || memorySearch?.model || "";
  const target = resolveEmbeddingsTarget({ requestModel: overrideModel, configuredProvider });
  if ("errorMessage" in target) {
    sendJson(res, 400, {
      error: {
        message: target.errorMessage,
        type: "invalid_request_error",
      },
    });
    return true;
  }

  const options: EmbeddingProviderOptions = {
    config: cfg,
    agentDir,
    provider: target.provider,
    model: target.model,
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
