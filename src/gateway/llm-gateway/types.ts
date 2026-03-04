/**
 * LLM Gateway - Cost-Optimized LLM Routing System
 *
 * Types and interfaces for the three-tier routing system
 */

// Provider tiers
export type TierLevel = "local" | "cheap" | "premium";

export interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKey?: string;
  defaultModel: string;
  tier: TierLevel;
  costPer1kTokens: number;
  maxTokens: number;
  timeout: number;
}

export interface GroqConfig extends ProviderConfig {
  tier: "cheap";
  models: string[];
}

export interface AnthropicConfig extends ProviderConfig {
  tier: "premium";
  models: string[];
}

export interface LocalConfig extends ProviderConfig {
  tier: "local";
  models: string[];
}

// Request types
export interface GatewayRequest {
  id: string;
  messages: ChatMessage[];
  model?: string;
  tier?: TierLevel;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  metadata?: Record<string, unknown>;
  tools?: ToolDefinition[];
  responseFormat?: { type: "text" | "json_object" | "diff" };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentBlock[];
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ContentBlock {
  type: "text" | "image" | "tool_use" | "tool_result";
  text?: string;
  source?: { type: string; media_type: string; data: string };
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  toolUseId?: string;
  content?: string;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

// Response types
export interface GatewayResponse {
  id: string;
  requestId: string;
  tier: TierLevel;
  provider: string;
  model: string;
  content: string;
  diffPatches?: DiffPatch[];
  toolCalls?: ToolCall[];
  usage: TokenUsage;
  cost: number;
  cached: boolean;
  latencyMs: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// Diff types for diff-only response mode
export interface DiffPatch {
  type: "add" | "remove" | "context" | "hunk_header";
  content: string;
  lineNumber?: number;
  riskScore?: number;
}

export interface ParsedDiff {
  hunks: DiffHunk[];
  files: string[];
  additions: number;
  deletions: number;
  riskScore: number;
}

export interface DiffHunk {
  header: string;
  lines: DiffPatch[];
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

// Cache types
export interface CacheEntry<T> {
  key: string;
  value: T;
  embedding?: number[];
  createdAt: number;
  expiresAt: number;
  hits: number;
  tier: "exact" | "semantic";
}

export interface CacheConfig {
  exactCacheTTL: number;
  semanticCacheTTL: number;
  maxExactCacheSize: number;
  maxSemanticCacheSize: number;
  embeddingModel: string;
  similarityThreshold: number;
}

// Security types
export interface SecurityPolicy {
  enabled: boolean;
  hardPolicyGate: boolean;
  rateLimitPerMinute: number;
  rateLimitPerHour: number;
  dailyBudgetLimit: number;
  killSwitchEnabled: boolean;
  blockedPatterns: string[];
  allowedModels: string[];
  defaultModel?: string;
}

export interface RateLimitState {
  minuteCount: number;
  minuteResetAt: number;
  hourCount: number;
  hourResetAt: number;
  dailyCost: number;
  dailyResetAt: number;
}

export interface SecurityCheckResult {
  allowed: boolean;
  reason?: string;
  retryAfter?: number;
}

// Metrics types
export interface GatewayMetrics {
  requestsTotal: number;
  requestsByTier: Record<TierLevel, number>;
  cacheHits: number;
  cacheMisses: number;
  totalCost: number;
  avgLatencyMs: number;
  errorsTotal: number;
  tokensByTier: Record<TierLevel, { prompt: number; completion: number }>;
}

export interface PrometheusMetric {
  name: string;
  help: string;
  type: "counter" | "gauge" | "histogram";
  labels?: Record<string, string>;
  value: number;
}

// Routing types
export interface RoutingDecision {
  tier: TierLevel;
  provider: string;
  model: string;
  reason: string;
  estimatedCost: number;
  estimatedLatencyMs: number;
}

export interface RoutingContext {
  query: string;
  messageCount: number;
  totalTokens: number;
  hasTools: boolean;
  hasImages: boolean;
  requiresSearch: boolean;
  complexityScore: number;
  intent: QueryIntent;
}

export type QueryIntent =
  | "simple"
  | "code_generation"
  | "code_edit"
  | "analysis"
  | "research"
  | "creative"
  | "vision"
  | "tool_use";

// Gateway configuration
export interface LLMGatewayConfig {
  providers: {
    local?: LocalConfig;
    cheap: GroqConfig;
    premium: AnthropicConfig;
  };
  cache: CacheConfig;
  security: SecurityPolicy;
  routing: {
    strategy: "cascade" | "cost_optimized" | "quality_first";
    enableAutoEscalation: boolean;
    maxEscalationAttempts: number;
    fallbackTier: TierLevel;
  };
  diffOnly: {
    enabled: boolean;
    systemPrompt: string;
    maxPatchSize: number;
    riskThreshold: number;
  };
  monitoring: {
    enabled: boolean;
    prometheusPort: number;
    logLevel: "debug" | "info" | "warn" | "error";
  };
}

export const DEFAULT_CONFIG: LLMGatewayConfig = {
  providers: {
    cheap: {
      name: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      defaultModel: "llama-3.1-8b-instant",
      tier: "cheap",
      costPer1kTokens: 0.0001,
      maxTokens: 8192,
      timeout: 30000,
      models: ["llama-3.1-8b-instant", "llama-3.1-70b-versatile", "mixtral-8x7b-32768"],
    },
    premium: {
      name: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      defaultModel: "claude-3-haiku-20240307",
      tier: "premium",
      costPer1kTokens: 0.25,
      maxTokens: 4096,
      timeout: 60000,
      models: ["claude-3-haiku-20240307", "claude-3-5-sonnet-20241022", "claude-3-opus-20240229"],
    },
  },
  cache: {
    exactCacheTTL: 3600000, // 1 hour
    semanticCacheTTL: 86400000, // 24 hours
    maxExactCacheSize: 10000,
    maxSemanticCacheSize: 5000,
    embeddingModel: "text-embedding-3-small",
    similarityThreshold: 0.95,
  },
  security: {
    enabled: true,
    hardPolicyGate: true,
    rateLimitPerMinute: 60,
    rateLimitPerHour: 1000,
    dailyBudgetLimit: 50,
    killSwitchEnabled: false,
    blockedPatterns: [],
    allowedModels: ["*"],
  },
  routing: {
    strategy: "cascade",
    enableAutoEscalation: true,
    maxEscalationAttempts: 3,
    fallbackTier: "cheap",
  },
  diffOnly: {
    enabled: true,
    systemPrompt: `You are a code editing assistant. When making code changes, output ONLY unified diff format.

Rules:
1. Output changes as unified diff (--- a/file, +++ b/file, @@ hunk headers)
2. Include minimal context (3 lines before/after changes)
3. Never output full file content - only the diffs
4. Use standard diff notation: - for removed lines, + for added lines, space for context
5. If no changes needed, output: "No changes required"

Example format:
--- a/src/example.ts
+++ b/src/example.ts
@@ -10,6 +10,7 @@
 function example() {
   const x = 1;
+  const y = 2;
   return x;
 }`,
    maxPatchSize: 65536,
    riskThreshold: 0.7,
  },
  monitoring: {
    enabled: true,
    prometheusPort: 9090,
    logLevel: "info",
  },
};
