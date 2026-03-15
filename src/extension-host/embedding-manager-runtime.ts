import { resolveAgentDir } from "../agents/agent-scope.js";
import type { ResolvedMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/config.js";
import { DEFAULT_GEMINI_EMBEDDING_MODEL } from "../memory/embeddings-gemini.js";
import { DEFAULT_MISTRAL_EMBEDDING_MODEL } from "../memory/embeddings-mistral.js";
import { DEFAULT_OLLAMA_EMBEDDING_MODEL } from "../memory/embeddings-ollama.js";
import { DEFAULT_OPENAI_EMBEDDING_MODEL } from "../memory/embeddings-openai.js";
import { DEFAULT_VOYAGE_EMBEDDING_MODEL } from "../memory/embeddings-voyage.js";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderId,
  type GeminiEmbeddingClient,
  type MistralEmbeddingClient,
  type OllamaEmbeddingClient,
  type OpenAiEmbeddingClient,
  type VoyageEmbeddingClient,
} from "./embedding-runtime.js";

export type EmbeddingManagerBatchConfig = {
  enabled: boolean;
  wait: boolean;
  concurrency: number;
  pollIntervalMs: number;
  timeoutMs: number;
};

export type EmbeddingManagerRuntimeState = {
  provider: EmbeddingProvider | null;
  fallbackFrom?: EmbeddingProviderId;
  openAi?: OpenAiEmbeddingClient;
  gemini?: GeminiEmbeddingClient;
  voyage?: VoyageEmbeddingClient;
  mistral?: MistralEmbeddingClient;
  ollama?: OllamaEmbeddingClient;
};

export type EmbeddingManagerFallbackActivation = EmbeddingManagerRuntimeState & {
  fallbackFrom: EmbeddingProviderId;
  fallbackReason: string;
};

export function resolveEmbeddingManagerBatchConfig(params: {
  settings: Pick<ResolvedMemorySearchConfig, "remote">;
  state: EmbeddingManagerRuntimeState;
}): EmbeddingManagerBatchConfig {
  const batch = params.settings.remote?.batch;
  const { provider } = params.state;
  const enabled = Boolean(
    batch?.enabled &&
    provider &&
    ((params.state.openAi && provider.id === "openai") ||
      (params.state.gemini && provider.id === "gemini") ||
      (params.state.voyage && provider.id === "voyage")),
  );
  return {
    enabled,
    wait: batch?.wait ?? true,
    concurrency: Math.max(1, batch?.concurrency ?? 2),
    pollIntervalMs: batch?.pollIntervalMs ?? 2000,
    timeoutMs: (batch?.timeoutMinutes ?? 60) * 60 * 1000,
  };
}

export async function activateEmbeddingManagerFallbackProvider(params: {
  cfg: OpenClawConfig;
  agentId: string;
  settings: Pick<
    ResolvedMemorySearchConfig,
    "fallback" | "local" | "model" | "outputDimensionality" | "remote"
  >;
  state: EmbeddingManagerRuntimeState;
  reason: string;
}): Promise<EmbeddingManagerFallbackActivation | null> {
  const fallback = params.settings.fallback;
  const { provider, fallbackFrom } = params.state;
  if (!fallback || fallback === "none" || !provider || fallback === provider.id || fallbackFrom) {
    return null;
  }

  const result = await createEmbeddingProvider({
    config: params.cfg,
    agentDir: resolveAgentDir(params.cfg, params.agentId),
    provider: fallback,
    remote: params.settings.remote,
    model: resolveEmbeddingFallbackModel(fallback, params.settings.model),
    outputDimensionality: params.settings.outputDimensionality,
    fallback: "none",
    local: params.settings.local,
  });

  return {
    provider: result.provider,
    fallbackFrom: provider.id as EmbeddingProviderId,
    fallbackReason: params.reason,
    openAi: result.openAi,
    gemini: result.gemini,
    voyage: result.voyage,
    mistral: result.mistral,
    ollama: result.ollama,
  };
}

function resolveEmbeddingFallbackModel(
  fallback: Exclude<ResolvedMemorySearchConfig["fallback"], undefined | "none">,
  configuredModel: string,
): string {
  switch (fallback) {
    case "gemini":
      return DEFAULT_GEMINI_EMBEDDING_MODEL;
    case "openai":
      return DEFAULT_OPENAI_EMBEDDING_MODEL;
    case "voyage":
      return DEFAULT_VOYAGE_EMBEDDING_MODEL;
    case "mistral":
      return DEFAULT_MISTRAL_EMBEDDING_MODEL;
    case "ollama":
      return DEFAULT_OLLAMA_EMBEDDING_MODEL;
    case "local":
      return configuredModel;
  }
}
