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
};

export type ModelProviderAuthMode = "api-key" | "aws-sdk" | "oauth" | "token";

export type ModelProviderEndpointHealthConfig = {
  /** Optional health check URL for endpoint selection. */
  url?: string;
  /** HTTP method for health checks (default: GET). */
  method?: "GET" | "HEAD" | "POST";
  /** Optional request body for health checks (POST only). */
  body?: string;
  /** Timeout in milliseconds (default: 1500). */
  timeoutMs?: number;
  /** Acceptable HTTP status codes (default: [200]). */
  successStatus?: number[];
  /** Cache TTL in milliseconds (default: 10000). */
  cacheTtlMs?: number;
};

export type ModelProviderEndpointConfig = {
  /** Optional endpoint identifier for logs. */
  id?: string;
  /** Base URL for this endpoint. */
  baseUrl: string;
  /** Optional API key override for this endpoint. */
  apiKey?: string;
  /** Optional auth mode override for this endpoint. */
  auth?: ModelProviderAuthMode;
  /** Optional headers override for this endpoint. */
  headers?: Record<string, string>;
  /** Optional authHeader override for this endpoint. */
  authHeader?: boolean;
  /** Lower numbers are higher priority (default: 0). */
  priority?: number;
  /** Optional health check configuration. */
  health?: ModelProviderEndpointHealthConfig;
};

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
  /** Optional endpoint list for automatic failover. */
  endpoints?: ModelProviderEndpointConfig[];
  /** Endpoint selection strategy (default: "health"). */
  endpointStrategy?: "ordered" | "health";
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
