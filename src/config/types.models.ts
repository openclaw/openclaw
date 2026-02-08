export type ModelApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "github-copilot"
  | "bedrock-converse-stream";

export type ModelCompatConfig = {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  /**
   * For some OpenAI-compatible servers (e.g. local vLLM), tool calling is only
   * supported via `POST /v1/chat/completions` with `tools` + `tool_choice`.
   *
   * When enabled for an `openai-completions` model, Moltbot routes the agent's
   * toolset through the SDK tool path so tools are included in the request.
   */
  openaiCompletionsTools?: boolean;
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
  apiKey?: string;
  auth?: ModelProviderAuthMode;
  api?: ModelApi;
  headers?: Record<string, string>;
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
