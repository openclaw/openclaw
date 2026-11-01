import type { EmbeddingUsage } from "../../packages/llm-core/src/usage-cost.js";

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

export type { EmbeddingUsage } from "../../packages/llm-core/src/usage-cost.js";

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

/** One text chunk submitted through a provider-owned asynchronous embedding batch. */
export type EmbeddingBatchChunk = {
  text: string;
};

/** Host-controlled execution parameters for an asynchronous embedding batch. */
export type EmbeddingBatchOptions = {
  agentId: string;
  chunks: EmbeddingBatchChunk[];
  /** The host applied an explicit document format; skip provider document templates. */
  documentFormatApplied?: boolean;
  wait: boolean;
  concurrency: number;
  pollIntervalMs: number;
  timeoutMs: number;
  debug: (message: string, data?: Record<string, unknown>) => void;
};

/** Provider-owned asynchronous batching capability, independent of host runtime metadata. */
export type EmbeddingProviderBatchRuntime = {
  /** Returns one vector per chunk in input order, or null to use host fallback. */
  batchEmbed: (options: EmbeddingBatchOptions) => Promise<number[][] | null>;
  /** Only true enables batching across dirty files; false or omission retains per-file batches. */
  sourceWideBatchEmbed?: boolean;
};
