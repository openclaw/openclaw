/** Type contracts for plugin-contributed embedding providers. */
import type { MemorySearchDeadlineControlOptions } from "../../packages/memory-host-sdk/src/host/search-deadline-control.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretInput } from "../config/types.secrets.js";
import type { EmbeddingProviderBatchRuntime } from "./embedding-provider-runtime-types.js";

/** Input accepted by embedding providers, including multimodal inline-data parts. */
export type EmbeddingInput =
  | string
  | {
      text: string;
      parts?: Array<
        { type: "text"; text: string } | { type: "inline-data"; mimeType: string; data: string }
      >;
    };

/** Per-call options passed to embedding provider calls. */
export type EmbeddingProviderCallOptions = {
  signal?: AbortSignal;
  inputType?: "query" | "document" | "semantic" | "classification" | "clustering";
} & MemorySearchDeadlineControlOptions;

/** Runtime metadata returned with a created embedding provider. */
export type EmbeddingProviderRuntime = {
  id: string;
  cacheKeyData?: Record<string, unknown>;
  /** Prior persisted model/cache identities that are equivalent to the current identity. */
  indexIdentityAliases?: Array<{
    model: string;
    cacheKeyData: Record<string, unknown>;
  }>;
  inlineQueryTimeoutMs?: number;
  inlineBatchTimeoutMs?: number;
} & Partial<EmbeddingProviderBatchRuntime>;

/** Provider-owned canonical identity and exact aliases for persisted indexes. */
export type EmbeddingProviderIndexIdentity = {
  model: string;
  cacheKeyData: Record<string, unknown>;
  aliases?: Array<{
    model: string;
    cacheKeyData: Record<string, unknown>;
  }>;
};

/** Created embedding provider instance used by memory/search callers. */
export type EmbeddingProvider = {
  id: string;
  model: string;
  dimensions?: number;
  maxInputTokens?: number;
  embed: (input: EmbeddingInput, options?: EmbeddingProviderCallOptions) => Promise<number[]>;
  embedBatch: (
    inputs: EmbeddingInput[],
    options?: EmbeddingProviderCallOptions,
  ) => Promise<number[][]>;
  /**
   * Optional extension of `embedBatch` that also surfaces provider-reported token usage.
   * Implementations must return the same vectors as `embedBatch` for the same inputs and
   * may omit `usage` when the provider does not report it. When usage is reported for
   * only part of the batch (for example one aggregated query response omits it), the
   * implementation must omit `usage` rather than report an undercounted total.
   */
  embedBatchDetailed?: (
    inputs: EmbeddingInput[],
    options?: EmbeddingProviderCallOptions,
  ) => Promise<EmbeddingBatchDetailedResult>;
  close?: () => Promise<void> | void;
};

/** Token usage reported by an embedding provider for a batch call. */
export type EmbeddingUsage = {
  promptTokens: number;
  totalTokens: number;
};

/** Vectors plus optional provider-reported usage returned by `embedBatchDetailed`. */
export type EmbeddingBatchDetailedResult = {
  embeddings: number[][];
  usage?: EmbeddingUsage;
};

/** Options passed to embedding provider adapters when creating providers. */
export type EmbeddingProviderCreateOptions = {
  config: OpenClawConfig;
  agentDir?: string;
  provider?: string;
  remote?: {
    baseUrl?: string;
    apiKey?: SecretInput;
    headers?: Record<string, string>;
  };
  model: string;
  inputType?: string;
  queryInputType?: string;
  documentInputType?: string;
  local?: {
    modelPath?: string;
    modelCacheDir?: string;
  };
  dimensions?: number;
  taskType?: string;
};

/** Result returned by an embedding provider adapter create call. */
export type EmbeddingProviderCreateResult = {
  provider: EmbeddingProvider | null;
  runtime?: EmbeddingProviderRuntime;
};

/** Adapter contract registered by core or plugin embedding providers. */
export type EmbeddingProviderAdapter = {
  id: string;
  defaultModel?: string;
  transport?: "local" | "remote";
  authProviderId?: string;
  /** Canonical model from config only: synchronous, without auth or network access. */
  normalizeModel?: (options: EmbeddingProviderCreateOptions) => string;
  resolveIndexIdentity?: (
    options: EmbeddingProviderCreateOptions,
  ) => EmbeddingProviderIndexIdentity;
  create: (options: EmbeddingProviderCreateOptions) => Promise<EmbeddingProviderCreateResult>;
  formatSetupError?: (err: unknown) => string;
};

/** Registered embedding provider with optional owning plugin metadata. */
export type RegisteredEmbeddingProvider = {
  adapter: EmbeddingProviderAdapter;
  ownerPluginId?: string;
};
