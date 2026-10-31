/** Contracts for plugin-contributed embedding providers. */
import type { AcquireConfiguredProviderLocalService } from "../agents/provider-local-service-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretInput } from "../config/types.secrets.js";
import type { EmbeddingProviderBatchRuntime } from "./embedding-provider-runtime-types.js";

/**
 * Per-call channel for phases with their own budget, such as managed local-service
 * readiness. Symbol keys never serialize into provider requests or tool payloads.
 */
export const EMBEDDING_DEADLINE_CONTROL: unique symbol = Symbol(
  "openclaw.memory-search-deadline-control",
);

type EmbeddingDeadlineControlAction = "pause" | "resume";

/**
 * Owned phases report; deadline owners subscribe. The control owner balances
 * concurrent phases: pause on 0→1 and resume on the final 1→0 transition.
 * Caller cancellation stays on the AbortSignal, outside this channel.
 */
export type EmbeddingDeadlineControl = {
  report: (action: EmbeddingDeadlineControlAction) => void;
  subscribe: (listener: (action: EmbeddingDeadlineControlAction) => void) => () => void;
};

export type EmbeddingDeadlineControlOptions = {
  [EMBEDDING_DEADLINE_CONTROL]?: EmbeddingDeadlineControl;
};

/** Input accepted by embedding providers, including multimodal inline-data parts. */
export type EmbeddingInput =
  | string
  | {
      text: string;
      parts?: Array<
        { type: "text"; text: string } | { type: "inline-data"; mimeType: string; data: string }
      >;
    };

/** Provider-reported token counts for one embedding request. */
export type EmbeddingUsage = {
  promptTokens: number;
  totalTokens: number;
};

/** Per-call options passed to embedding provider calls. */
export type EmbeddingProviderCallOptions = {
  signal?: AbortSignal;
  inputType?: "query" | "document" | "semantic" | "classification" | "clustering";
  /** The host applied an explicit query instruction; skip provider query templates. */
  queryInstructionApplied?: boolean;
  /** The host applied an explicit document format; skip provider document templates. */
  documentFormatApplied?: boolean;
  /** Report each successful upstream request before resolving; undefined means usage unavailable. */
  onUsage?: (usage: EmbeddingUsage | undefined) => void;
} & EmbeddingDeadlineControlOptions;

/** Runtime metadata returned with a created embedding provider. */
export type EmbeddingProviderRuntime = {
  id: string;
  cacheKeyData?: Record<string, unknown>;
  /** Equivalent prior identities; alias cache reads require matching published index metadata. */
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
  /** Positive safe integer cap for memory embedding requests; omit when the endpoint limit is unknown. */
  maxInputsPerRequest?: number;
  embed: (input: EmbeddingInput, options?: EmbeddingProviderCallOptions) => Promise<number[]>;
  embedBatch: (
    inputs: EmbeddingInput[],
    options?: EmbeddingProviderCallOptions,
  ) => Promise<number[][]>;
  close?: () => Promise<void> | void;
};

/** Options passed to embedding provider adapters when creating providers. */
export type EmbeddingProviderCreateOptions = {
  config: OpenClawConfig;
  agentDir?: string;
  /** Host-injected acquisition of the configured provider's local service. */
  acquireLocalService?: AcquireConfiguredProviderLocalService;
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
  /** Alternate lookup ids; creation and index identity retain the canonical id. */
  aliases?: readonly string[];
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
