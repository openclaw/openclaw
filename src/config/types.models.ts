export type ModelApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "github-copilot"
  | "bedrock-converse-stream"
  | "ollama";

export type ModelCompatConfig = {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  supportsUsageInStreaming?: boolean;
  supportsStrictMode?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  thinkingFormat?: "openai" | "zai" | "qwen";
  requiresToolResultName?: boolean;
  requiresAssistantAfterToolResult?: boolean;
  requiresThinkingAsText?: boolean;
  requiresMistralToolIds?: boolean;
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

export type ProviderConcurrencyConfig = {
  /**
   * Maximum concurrent requests allowed for this provider/endpoint.
   * Especially useful for local LLMs (llamacpp, vllm) that struggle with concurrent requests.
   * Set to 1 for strict serialization, higher numbers for limited concurrency.
   * Default: Infinity (no limit)
   */
  maxConcurrent?: number;

  /**
   * Maximum time (ms) a request can wait in the queue before timing out.
   * Default: 30000 (30 seconds)
   */
  queueTimeoutMs?: number;

  /**
   * Whether to enable verbose logging for this provider's concurrency limiting.
   * Default: false
   */
  verbose?: boolean;
};

export type ModelProviderConfig = {
  baseUrl: string;
  apiKey?: string;
  auth?: ModelProviderAuthMode;
  api?: ModelApi;
  headers?: Record<string, string>;
  authHeader?: boolean;
  models: ModelDefinitionConfig[];
  /**
   * Concurrency limiting config for this provider.
   * Prevents resource contention when multiple agents compete for the same endpoint.
   */
  concurrency?: ProviderConcurrencyConfig;
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
  /**
   * Default concurrency limiting config applied to all providers unless overridden.
   * Example: { maxConcurrent: 1 } to serialize all LLM requests globally.
   */
  defaultConcurrency?: ProviderConcurrencyConfig;
};
