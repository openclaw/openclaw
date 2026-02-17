/**
 * Core provider types and interfaces.
 * Centralizes all provider-related type definitions.
 */

/* eslint-disable @typescript-eslint/no-redundant-type-constituents */
export type ProviderId =
  | "anthropic"
  | "openai"
  | "google"
  | "google-gemini-cli"
  | "google-antigravity"
  | "amazon-bedrock"
  | "mistral"
  | "groq"
  | "cerebras"
  | "openrouter"
  | "github-copilot"
  | "openai-codex"
  | "ollama"
  | "minimax"
  | "xiaomi"
  | "moonshot"
  | "qwen-portal"
  | "zai"
  | "venice"
  | "xai"
  | "azure-openai"
  | "huggingface"
  | string;
/* eslint-enable @typescript-eslint/no-redundant-type-constituents */

export type ProviderAuthMode = "api-key" | "oauth" | "token" | "aws-sdk" | "cli" | "none";

export type ProviderCapability =
  | "text"
  | "vision"
  | "tools"
  | "reasoning"
  | "streaming"
  | "caching"
  | "system-prompt"
  | "extended-thinking";

export type ProviderStatus = "active" | "cooldown" | "degraded" | "offline" | "unknown";

/**
 * Provider metadata and configuration.
 */
export interface ProviderDefinition {
  /** Canonical provider ID (lowercase, normalized) */
  id: ProviderId;
  /** Human-readable name */
  name: string;
  /** Known aliases for this provider */
  aliases?: string[];
  /** Supported auth modes (in preference order) */
  authModes: ProviderAuthMode[];
  /** Provider capabilities */
  capabilities: ProviderCapability[];
  /** Whether this is a local provider (no cloud API) */
  isLocal?: boolean;
  /** Default base URL */
  defaultBaseUrl?: string;
  /** Whether this provider requires authentication */
  requiresAuth?: boolean;
}

/**
 * Provider health metrics.
 */
export interface ProviderHealthMetrics {
  providerId: ProviderId;
  status: ProviderStatus;
  /** Total API calls made */
  totalCalls: number;
  /** Successful calls */
  successfulCalls: number;
  /** Failed calls */
  failedCalls: number;
  /** Success rate (0-1) */
  successRate: number;
  /** Average response time (ms) */
  avgResponseTime: number;
  /** Last successful call timestamp */
  lastSuccess?: number;
  /** Last failure timestamp */
  lastFailure?: number;
  /** Cooldown end timestamp (if in cooldown) */
  cooldownUntil?: number;
  /** Error rate threshold violations */
  errorRateViolations: number;
}

/**
 * Model capabilities (extends provider capabilities).
 */
export interface ModelCapabilities {
  /** Maximum context window (tokens) */
  contextWindow: number;
  /** Maximum output tokens */
  maxTokens?: number;
  /** Supports vision/image inputs */
  vision: boolean;
  /** Supports tool/function calling */
  tools: boolean;
  /** Extended reasoning/thinking mode */
  reasoning: boolean;
  /** Supports streaming responses */
  streaming: boolean;
  /** Supports prompt caching */
  caching: boolean;
  /** Input modalities */
  input: Array<"text" | "image" | "audio" | "video">;
  /** Output modalities */
  output: Array<"text" | "image" | "audio">;
}

/**
 * Unified model reference.
 */
export interface ModelRef {
  provider: ProviderId;
  model: string;
  accountTag?: string;
}

/**
 * Model catalog entry with capabilities.
 */
export interface ModelCatalogEntry {
  id: string;
  name: string;
  provider: ProviderId;
  contextWindow?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  /** Extended capabilities */
  capabilities?: Partial<ModelCapabilities>;
}

/**
 * Provider detection result.
 */
export interface ProviderDetectionResult {
  providerId: ProviderId;
  detected: boolean;
  authMode?: ProviderAuthMode;
  authSource?: "auth-profile" | "env" | "config" | "aws-sdk" | "cli";
  baseUrl?: string;
  error?: string;
}
