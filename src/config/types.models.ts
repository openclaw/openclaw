import type { SecretInput } from "./types.secrets.js";

export const MODEL_APIS = [
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "google-generative-ai",
  "github-copilot",
  "bedrock-converse-stream",
  "ollama",
] as const;

export type ModelApi = (typeof MODEL_APIS)[number];

export type ModelCompatConfig = {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  supportsUsageInStreaming?: boolean;
  supportsTools?: boolean;
  supportsStrictMode?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  thinkingFormat?: "openai" | "zai" | "qwen";
  requiresToolResultName?: boolean;
  requiresAssistantAfterToolResult?: boolean;
  requiresThinkingAsText?: boolean;
  requiresMistralToolIds?: boolean;
  requiresOpenAiAnthropicToolPayload?: boolean;
};

export type ModelProviderAuthMode = "api-key" | "aws-sdk" | "oauth" | "token";

export type ModelDefinitionConfig = {
  id: string;
  name: string;
  api?: ModelApi;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: ModelCompatConfig;
};

export type ModelProviderConfig = {
  baseUrl: string;
  apiKey?: SecretInput;
  auth?: ModelProviderAuthMode;
  api?: ModelApi;
  injectNumCtxForOpenAICompat?: boolean;
  headers?: Record<string, SecretInput>;
  authHeader?: boolean;
  models: ModelDefinitionConfig[];
};

export type BedrockDiscoveryConfig = {
  enabled?: boolean;
  region?: string;
  providerFilter?: string[];
  refreshInterval?: number;
  defaultContextWindow?: number;
  defaultMaxTokens?: number;
};

export type ModelsConfig = {
  mode?: "merge" | "replace";
  providers?: Record<string, ModelProviderConfig>;
  bedrockDiscovery?: BedrockDiscoveryConfig;
};

/**
 * Simplified LLM configuration shorthand.
 * Expands into `models.providers` + `agents.defaults.model.primary` at runtime.
 *
 * Example:
 *   { llm: { provider: "openai-compatible", model: "deepseek-chat",
 *            api_key: "sk-...", base_url: "https://api.deepseek.com",
 *            temperature: 0.7 } }
 */
export type LlmConfig = {
  /**
   * API protocol type. Supported shorthands:
   *   "openai-compatible"    → api: "openai-completions"
   *   "anthropic-compatible" → api: "anthropic-messages"
   * Any raw ModelApi value is also accepted directly.
   */
  provider: string;
  /** Model ID, e.g. "deepseek-chat" or "claude-opus-4-6". */
  model: string;
  /** API key. Accepts plain string or SecretInput ref. */
  api_key?: SecretInput;
  /** Provider base URL, e.g. "https://api.deepseek.com". */
  base_url?: string;
  /**
   * Inference temperature (0–2).
   * Stored in agents.defaults.models[ref].params.temperature.
   */
  temperature?: number;
  /**
   * Custom provider key written to models.json.
   * Defaults to "custom".
   */
  provider_id?: string;
};
