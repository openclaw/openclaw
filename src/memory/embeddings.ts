import fsSync from "node:fs";
import type { Llama, LlamaEmbeddingContext, LlamaModel } from "node-llama-cpp";
import { normalizeProviderId } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SecretInput } from "../config/types.secrets.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveProxyFetchFromEnv } from "../infra/net/proxy-fetch.js";
import { getPluginProvidersByCapability, type PluginProviderEntry } from "../plugins/runtime.js";
import { resolveUserPath } from "../utils.js";
import type { EmbeddingInput } from "./embedding-inputs.js";
import { sanitizeAndNormalizeEmbedding } from "./embedding-vectors.js";
import {
  createGeminiEmbeddingProvider,
  type GeminiEmbeddingClient,
  type GeminiTaskType,
} from "./embeddings-gemini.js";
import {
  createMistralEmbeddingProvider,
  type MistralEmbeddingClient,
} from "./embeddings-mistral.js";
import { createOllamaEmbeddingProvider, type OllamaEmbeddingClient } from "./embeddings-ollama.js";
import { createOpenAiEmbeddingProvider, type OpenAiEmbeddingClient } from "./embeddings-openai.js";
import { createVoyageEmbeddingProvider, type VoyageEmbeddingClient } from "./embeddings-voyage.js";
import { importNodeLlamaCpp } from "./node-llama.js";
import { resolveMemorySecretInputString } from "./secret-input.js";

export type { GeminiEmbeddingClient } from "./embeddings-gemini.js";
export type { MistralEmbeddingClient } from "./embeddings-mistral.js";
export type { OpenAiEmbeddingClient } from "./embeddings-openai.js";
export type { VoyageEmbeddingClient } from "./embeddings-voyage.js";
export type { OllamaEmbeddingClient } from "./embeddings-ollama.js";

export type EmbeddingProvider = {
  id: string;
  model: string;
  maxInputTokens?: number;
  embedQuery: (text: string) => Promise<number[]>;
  embedBatch: (texts: string[]) => Promise<number[][]>;
  embedBatchInputs?: (inputs: EmbeddingInput[]) => Promise<number[][]>;
};

export type EmbeddingProviderId = "openai" | "local" | "gemini" | "voyage" | "mistral" | "ollama";
export type EmbeddingProviderRequest = string; // Allows built-in IDs, "auto", or custom plugin provider IDs
export type EmbeddingProviderFallback = string; // Allows built-in IDs, "none", or custom plugin provider IDs

// Remote providers considered for auto-selection when provider === "auto".
// Ollama is intentionally excluded here so that "auto" mode does not
// implicitly assume a local Ollama instance is available.
const REMOTE_EMBEDDING_PROVIDER_IDS = ["openai", "gemini", "voyage", "mistral"] as const;

export type EmbeddingProviderResult = {
  provider: EmbeddingProvider | null;
  requestedProvider: EmbeddingProviderRequest;
  fallbackFrom?: string;
  fallbackReason?: string;
  providerUnavailableReason?: string;
  openAi?: OpenAiEmbeddingClient;
  gemini?: GeminiEmbeddingClient;
  voyage?: VoyageEmbeddingClient;
  mistral?: MistralEmbeddingClient;
  ollama?: OllamaEmbeddingClient;
};

export type EmbeddingProviderOptions = {
  config: OpenClawConfig;
  agentDir?: string;
  provider: EmbeddingProviderRequest;
  remote?: {
    baseUrl?: string;
    apiKey?: SecretInput;
    headers?: Record<string, string>;
  };
  model: string;
  fallback: EmbeddingProviderFallback;
  local?: {
    modelPath?: string;
    modelCacheDir?: string;
  };
  /** Gemini embedding-2: output vector dimensions (768, 1536, or 3072). */
  outputDimensionality?: number;
  /** Gemini: override the default task type sent with embedding requests. */
  taskType?: GeminiTaskType;
};

export const DEFAULT_LOCAL_MODEL =
  "hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf";

function canAutoSelectLocal(options: EmbeddingProviderOptions): boolean {
  const modelPath = options.local?.modelPath?.trim();
  if (!modelPath) {
    return false;
  }
  if (/^(hf:|https?:)/i.test(modelPath)) {
    return false;
  }
  const resolved = resolveUserPath(modelPath);
  try {
    return fsSync.statSync(resolved).isFile();
  } catch {
    return false;
  }
}

function isMissingApiKeyError(err: unknown): boolean {
  const message = formatErrorMessage(err);
  return message.includes("No API key found for provider");
}

async function createLocalEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<EmbeddingProvider> {
  const modelPath = options.local?.modelPath?.trim() || DEFAULT_LOCAL_MODEL;
  const modelCacheDir = options.local?.modelCacheDir?.trim();

  // Lazy-load node-llama-cpp to keep startup light unless local is enabled.
  const { getLlama, resolveModelFile, LlamaLogLevel } = await importNodeLlamaCpp();

  let llama: Llama | null = null;
  let embeddingModel: LlamaModel | null = null;
  let embeddingContext: LlamaEmbeddingContext | null = null;
  let initPromise: Promise<LlamaEmbeddingContext> | null = null;

  const ensureContext = async (): Promise<LlamaEmbeddingContext> => {
    if (embeddingContext) {
      return embeddingContext;
    }
    if (initPromise) {
      return initPromise;
    }
    initPromise = (async () => {
      try {
        if (!llama) {
          llama = await getLlama({ logLevel: LlamaLogLevel.error });
        }
        if (!embeddingModel) {
          const resolved = await resolveModelFile(modelPath, modelCacheDir || undefined);
          embeddingModel = await llama.loadModel({ modelPath: resolved });
        }
        if (!embeddingContext) {
          embeddingContext = await embeddingModel.createEmbeddingContext();
        }
        return embeddingContext;
      } catch (err) {
        initPromise = null;
        throw err;
      }
    })();
    return initPromise;
  };

  return {
    id: "local",
    model: modelPath,
    embedQuery: async (text) => {
      const ctx = await ensureContext();
      const embedding = await ctx.getEmbeddingFor(text);
      return sanitizeAndNormalizeEmbedding(Array.from(embedding.vector));
    },
    embedBatch: async (texts) => {
      const ctx = await ensureContext();
      const embeddings = await Promise.all(
        texts.map(async (text) => {
          const embedding = await ctx.getEmbeddingFor(text);
          return sanitizeAndNormalizeEmbedding(Array.from(embedding.vector));
        }),
      );
      return embeddings;
    },
  };
}

function mapEmbeddingCapability(cap: string): cap is "embedding" {
  return cap === "embedding";
}

function getEmbeddingTimeout(options: EmbeddingProviderOptions): number {
  return options.config?.memory?.qmd?.limits?.timeoutMs ?? 60000;
}

function getPluginEmbeddingProvidersSync(
  options: EmbeddingProviderOptions,
): Record<string, EmbeddingProvider> {
  const fetchFn = resolveProxyFetchFromEnv();
  const providers = getPluginProvidersByCapability(
    mapEmbeddingCapability,
    (p: PluginProviderEntry) => {
      const embedFn = p.embed as
        | ((req: {
            text: string;
            model?: string;
            apiKey: string;
            baseUrl?: string;
            headers?: Record<string, string>;
            timeoutMs: number;
            fetchFn?: typeof fetch;
          }) => Promise<{ embedding: number[] }>)
        | undefined;
      const embedBatchFn = p.embedBatch as
        | ((req: {
            texts: string[];
            model?: string;
            apiKey: string;
            baseUrl?: string;
            headers?: Record<string, string>;
            timeoutMs: number;
            fetchFn?: typeof fetch;
          }) => Promise<{ embeddings: number[][] }>)
        | undefined;
      const embedBatchInputsFn = p.embedBatchInputs as
        | ((req: {
            inputs: {
              text: string;
              parts?: (
                | { type: "text"; text: string }
                | { type: "inline-data"; mimeType: string; data: string }
              )[];
            }[];
            model?: string;
            apiKey: string;
            baseUrl?: string;
            headers?: Record<string, string>;
            timeoutMs: number;
            fetchFn?: typeof fetch;
          }) => Promise<{ embeddings: number[][]; model?: string }>)
        | undefined;

      if (!embedFn && !embedBatchFn) {
        return undefined;
      }
      const normalizedId = normalizeProviderId(p.id);
      const resolvedApiKey = resolveMemorySecretInputString({
        value: options.remote?.apiKey,
        path: "agents.*.memorySearch.remote.apiKey",
      });
      const apiKey = resolvedApiKey ?? "";
      return {
        id: normalizedId,
        model: options.model,
        embedQuery: async (text: string) => {
          if (embedFn) {
            const result = await embedFn({
              text,
              model: options.model,
              apiKey,
              baseUrl: options.remote?.baseUrl,
              headers: options.remote?.headers,
              timeoutMs: getEmbeddingTimeout(options),
              fetchFn,
            });
            return result.embedding;
          }
          if (embedBatchFn) {
            const result = await embedBatchFn({
              texts: [text],
              model: options.model,
              apiKey,
              baseUrl: options.remote?.baseUrl,
              headers: options.remote?.headers,
              timeoutMs: getEmbeddingTimeout(options),
              fetchFn,
            });
            const embedding = result.embeddings[0];
            if (!embedding) {
              throw new Error(`Plugin embedding provider ${p.id} returned empty embeddings array`);
            }
            return embedding;
          }
          throw new Error(
            `Plugin embedding provider ${p.id} does not implement embed or embedBatch`,
          );
        },
        embedBatch: async (texts: string[]) => {
          if (embedBatchFn) {
            const result = await embedBatchFn({
              texts,
              model: options.model,
              apiKey,
              baseUrl: options.remote?.baseUrl,
              headers: options.remote?.headers,
              timeoutMs: getEmbeddingTimeout(options),
              fetchFn,
            });
            return result.embeddings;
          }
          if (!embedFn) {
            throw new Error(
              `Plugin embedding provider ${p.id} does not implement embed or embedBatch`,
            );
          }
          const results = await Promise.all(
            texts.map(async (text) => {
              const result = await embedFn({
                text,
                model: options.model,
                apiKey,
                baseUrl: options.remote?.baseUrl,
                headers: options.remote?.headers,
                timeoutMs: getEmbeddingTimeout(options),
                fetchFn,
              });
              return result.embedding;
            }),
          );
          return results;
        },
        embedBatchInputs: async (inputs: EmbeddingInput[]) => {
          if (embedBatchInputsFn) {
            const result = await embedBatchInputsFn({
              inputs: inputs as {
                text: string;
                parts?: (
                  | { type: "text"; text: string }
                  | { type: "inline-data"; mimeType: string; data: string }
                )[];
              }[],
              model: options.model,
              apiKey,
              baseUrl: options.remote?.baseUrl,
              headers: options.remote?.headers,
              timeoutMs: getEmbeddingTimeout(options),
              fetchFn,
            });
            return result.embeddings;
          }
          throw new Error(`Plugin embedding provider ${p.id} does not implement embedBatchInputs`);
        },
      };
    },
  );
  return providers;
}

function getPluginEmbeddingProviders(
  options: EmbeddingProviderOptions,
): Record<string, EmbeddingProvider> {
  return getPluginEmbeddingProvidersSync(options);
}

export async function createEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<EmbeddingProviderResult> {
  const requestedProvider = options.provider;
  const fallback = options.fallback;

  const pluginProviders = getPluginEmbeddingProviders(options);
  const normalizedRequested = normalizeProviderId(requestedProvider);
  const pluginProvider = pluginProviders[normalizedRequested];
  if (pluginProvider) {
    return { provider: pluginProvider, requestedProvider };
  }

  const createProvider = async (id: string) => {
    if (id === "local") {
      const provider = await createLocalEmbeddingProvider(options);
      return { provider };
    }
    if (id === "ollama") {
      const { provider, client } = await createOllamaEmbeddingProvider(options);
      return { provider, ollama: client };
    }
    if (id === "gemini") {
      const { provider, client } = await createGeminiEmbeddingProvider(options);
      return { provider, gemini: client };
    }
    if (id === "voyage") {
      const { provider, client } = await createVoyageEmbeddingProvider(options);
      return { provider, voyage: client };
    }
    if (id === "mistral") {
      const { provider, client } = await createMistralEmbeddingProvider(options);
      return { provider, mistral: client };
    }
    if (id === "openai") {
      const { provider, client } = await createOpenAiEmbeddingProvider(options);
      return { provider, openAi: client };
    }
    // Unknown ID and not a plugin – surface a clear error
    throw new Error(
      `Unknown embedding provider "${id}". Check your configuration or ensure the plugin that provides this ID is loaded.`,
    );
  };

  const formatPrimaryError = (err: unknown, provider: string) =>
    provider === "local" ? formatLocalSetupError(err) : formatErrorMessage(err);

  if (requestedProvider === "auto") {
    const missingKeyErrors: string[] = [];
    let localError: string | null = null;

    if (canAutoSelectLocal(options)) {
      try {
        const local = await createProvider("local");
        return { ...local, requestedProvider };
      } catch (err) {
        localError = formatLocalSetupError(err);
      }
    }

    for (const provider of REMOTE_EMBEDDING_PROVIDER_IDS) {
      try {
        const result = await createProvider(provider);
        return { ...result, requestedProvider };
      } catch (err) {
        if (isMissingApiKeyError(err)) {
          const message = formatPrimaryError(err, provider);
          missingKeyErrors.push(message);
          continue;
        }
        const wrapped = new Error(formatPrimaryError(err, provider)) as Error & { cause?: unknown };
        wrapped.cause = err;
        throw wrapped;
      }
    }

    // Plugin providers are only used when explicitly configured (not in auto mode).
    // Auto mode uses only built-in providers to preserve FTS-only fallback behavior.

    // All providers failed due to missing API keys - return null provider for FTS-only mode
    const details = [...missingKeyErrors, localError].filter(Boolean) as string[];
    const reason = details.length > 0 ? details.join("\n\n") : "No embeddings provider available.";
    return {
      provider: null,
      requestedProvider,
      providerUnavailableReason: reason,
    };
  }

  try {
    const primary = await createProvider(requestedProvider);
    return { ...primary, requestedProvider };
  } catch (primaryErr) {
    const reason = formatPrimaryError(primaryErr, requestedProvider);
    if (fallback && fallback !== "none" && fallback !== requestedProvider) {
      const normalizedFallback = normalizeProviderId(fallback);
      if (pluginProviders[normalizedFallback]) {
        return {
          provider: pluginProviders[normalizedFallback],
          requestedProvider,
          fallbackFrom: requestedProvider,
          fallbackReason: reason,
        };
      }
      try {
        const fallbackResult = await createProvider(fallback);
        return {
          ...fallbackResult,
          requestedProvider,
          fallbackFrom: requestedProvider,
          fallbackReason: reason,
        };
      } catch (fallbackErr) {
        // Both primary and fallback failed - check if it's auth-related
        const fallbackReason = formatErrorMessage(fallbackErr);
        const combinedReason = `${reason}\n\nFallback to ${fallback} failed: ${fallbackReason}`;
        if (isMissingApiKeyError(primaryErr) && isMissingApiKeyError(fallbackErr)) {
          // Both failed due to missing API keys - return null for FTS-only mode
          return {
            provider: null,
            requestedProvider,
            fallbackFrom: requestedProvider,
            fallbackReason: reason,
            providerUnavailableReason: combinedReason,
          };
        }
        // Non-auth errors are still fatal
        const wrapped = new Error(combinedReason) as Error & { cause?: unknown };
        wrapped.cause = fallbackErr;
        throw wrapped;
      }
    }
    // No fallback configured - check if we should degrade to FTS-only
    if (isMissingApiKeyError(primaryErr)) {
      return {
        provider: null,
        requestedProvider,
        providerUnavailableReason: reason,
      };
    }
    const wrapped = new Error(reason) as Error & { cause?: unknown };
    wrapped.cause = primaryErr;
    throw wrapped;
  }
}

function isNodeLlamaCppMissing(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const code = (err as Error & { code?: unknown }).code;
  if (code === "ERR_MODULE_NOT_FOUND") {
    return err.message.includes("node-llama-cpp");
  }
  return false;
}

function formatLocalSetupError(err: unknown): string {
  const detail = formatErrorMessage(err);
  const missing = isNodeLlamaCppMissing(err);
  return [
    "Local embeddings unavailable.",
    missing
      ? "Reason: optional dependency node-llama-cpp is missing (or failed to install)."
      : detail
        ? `Reason: ${detail}`
        : undefined,
    missing && detail ? `Detail: ${detail}` : null,
    "To enable local embeddings:",
    "1) Use Node 24 (recommended for installs/updates; Node 22 LTS, currently 22.16+, remains supported)",
    missing
      ? "2) Reinstall OpenClaw (this should install node-llama-cpp): npm i -g openclaw@latest"
      : null,
    "3) If you use pnpm: pnpm approve-builds (select node-llama-cpp), then pnpm rebuild node-llama-cpp",
    ...REMOTE_EMBEDDING_PROVIDER_IDS.map(
      (provider) => `Or set agents.defaults.memorySearch.provider = "${provider}" (remote).`,
    ),
  ]
    .filter(Boolean)
    .join("\n");
}
