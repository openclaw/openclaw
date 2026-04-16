/**
 * Provider registry — metadata + curated model catalogs for all supported AI providers.
 *
 * Each provider includes a `models` array with the exact fields the gateway
 * config schema requires (ModelDefinitionConfig).  When a user saves an API key,
 * these models are written into the config so the gateway can use them immediately.
 */

export type ProviderModelDef = {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

export type ProviderInfo = {
  id: string;
  label: string;
  description: string;
  baseUrl: string;
  /** OpenAI-compatible API type for OpenClaw config */
  api: string;
  placeholder: string;
  /** If true, show a "recommended" badge */
  recommended?: boolean;
  /** Suggestion text shown below the provider */
  suggestion?: string;
  /** Curated model catalog written into gateway config on key save */
  models: ProviderModelDef[];
  /** Default model ID (first model used if not specified) */
  defaultModel?: string;
};

// Re-export for backward compat
export type ProviderModel = {
  id: string;
  name: string;
  created?: number;
  contextWindow?: number;
  owned_by?: string;
};

// ── Provider Registry ───────────────────────────────────────────────

export const PROVIDER_REGISTRY: ProviderInfo[] = [
  // ── OpenAI ──
  {
    id: "openai",
    label: "OpenAI",
    description: "GPT-5.4, GPT-5.4 Mini, o3, o4-mini",
    baseUrl: "https://api.openai.com/v1",
    api: "openai-responses",
    placeholder: "sk-...",
    defaultModel: "gpt-5.4",
    models: [
      { id: "gpt-5.4", name: "GPT-5.4", reasoning: true, input: ["text", "image"], contextWindow: 1050000, maxTokens: 128000, cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 } },
      { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", reasoning: true, input: ["text", "image"], contextWindow: 400000, maxTokens: 128000, cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 } },
      { id: "gpt-5.4-nano", name: "GPT-5.4 Nano", reasoning: true, input: ["text", "image"], contextWindow: 400000, maxTokens: 128000, cost: { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0 } },
    ],
  },
  // ── Anthropic ──
  {
    id: "anthropic",
    label: "Anthropic",
    description: "Claude Opus 4.6, Sonnet 4.6, Haiku",
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    placeholder: "sk-ant-...",
    defaultModel: "claude-sonnet-4-6",
    models: [
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", reasoning: true, input: ["text", "image"], contextWindow: 1000000, maxTokens: 128000, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
      { id: "claude-opus-4-6", name: "Claude Opus 4.6", reasoning: true, input: ["text", "image"], contextWindow: 1000000, maxTokens: 128000, cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", reasoning: false, input: ["text", "image"], contextWindow: 200000, maxTokens: 8192, cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 } },
    ],
  },
  // ── Google ──
  {
    id: "google",
    label: "Google Gemini",
    description: "Gemini 2.5 Pro, Flash, 3.1 Pro",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    api: "google-generative-ai",
    placeholder: "AI...",
    defaultModel: "gemini-2.5-pro",
    models: [
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 65536, cost: { input: 1.25, output: 10, cacheRead: 0.315, cacheWrite: 0 } },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 65536, cost: { input: 0.15, output: 0.6, cacheRead: 0.0375, cacheWrite: 0 } },
      { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite", reasoning: false, input: ["text", "image"], contextWindow: 1048576, maxTokens: 65536, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ],
  },
  // ── Groq ──
  {
    id: "groq",
    label: "Groq",
    description: "Ultra-fast inference — Llama, Mixtral",
    baseUrl: "https://api.groq.com/openai/v1",
    api: "openai-completions",
    placeholder: "gsk_...",
    defaultModel: "llama-3.3-70b-versatile",
    models: [
      { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B", reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 32768, cost: { input: 0.59, output: 0.79, cacheRead: 0, cacheWrite: 0 } },
      { id: "llama-3.1-8b-instant", name: "Llama 3.1 8B", reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 8192, cost: { input: 0.05, output: 0.08, cacheRead: 0, cacheWrite: 0 } },
      { id: "mixtral-8x7b-32768", name: "Mixtral 8x7B", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 8192, cost: { input: 0.24, output: 0.24, cacheRead: 0, cacheWrite: 0 } },
    ],
  },
  // ── Mistral ──
  {
    id: "mistral",
    label: "Mistral",
    description: "Mistral Large, Codestral, Magistral",
    baseUrl: "https://api.mistral.ai/v1",
    api: "openai-completions",
    placeholder: "...",
    defaultModel: "mistral-large-latest",
    models: [
      { id: "mistral-large-latest", name: "Mistral Large", reasoning: false, input: ["text", "image"], contextWindow: 262144, maxTokens: 16384, cost: { input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0 } },
      { id: "codestral-latest", name: "Codestral", reasoning: false, input: ["text"], contextWindow: 256000, maxTokens: 4096, cost: { input: 0.3, output: 0.9, cacheRead: 0, cacheWrite: 0 } },
      { id: "magistral-small", name: "Magistral Small", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 40000, cost: { input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0 } },
      { id: "mistral-small-latest", name: "Mistral Small", reasoning: true, input: ["text", "image"], contextWindow: 128000, maxTokens: 16384, cost: { input: 0.1, output: 0.3, cacheRead: 0, cacheWrite: 0 } },
    ],
  },
  // ── OpenRouter ──
  {
    id: "openrouter",
    label: "OpenRouter",
    description: "Access 200+ models from one key",
    baseUrl: "https://openrouter.ai/api/v1",
    api: "openai-completions",
    placeholder: "sk-or-...",
    defaultModel: "auto",
    models: [
      { id: "auto", name: "OpenRouter Auto", reasoning: false, input: ["text", "image"], contextWindow: 200000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ],
  },
  // ── DeepSeek ──
  {
    id: "deepseek",
    label: "DeepSeek",
    description: "DeepSeek Chat, R1 Reasoning",
    baseUrl: "https://api.deepseek.com",
    api: "openai-completions",
    placeholder: "sk-...",
    defaultModel: "deepseek-chat",
    models: [
      { id: "deepseek-chat", name: "DeepSeek Chat", reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 8192, cost: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0 } },
      { id: "deepseek-reasoner", name: "DeepSeek Reasoner", reasoning: true, input: ["text"], contextWindow: 131072, maxTokens: 65536, cost: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0 } },
    ],
  },
  // ── Together AI ──
  {
    id: "together",
    label: "Together AI",
    description: "Llama, Kimi K2.5, DeepSeek, GLM",
    baseUrl: "https://api.together.xyz/v1",
    api: "openai-completions",
    placeholder: "...",
    defaultModel: "moonshotai/Kimi-K2.5",
    models: [
      { id: "moonshotai/Kimi-K2.5", name: "Kimi K2.5", reasoning: true, input: ["text", "image"], contextWindow: 262144, maxTokens: 32768, cost: { input: 0.5, output: 2.8, cacheRead: 0.5, cacheWrite: 2.8 } },
      { id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", name: "Llama 3.3 70B Turbo", reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 8192, cost: { input: 0.88, output: 0.88, cacheRead: 0.88, cacheWrite: 0.88 } },
      { id: "deepseek-ai/DeepSeek-V3.1", name: "DeepSeek V3.1", reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 8192, cost: { input: 0.6, output: 1.25, cacheRead: 0.6, cacheWrite: 0.6 } },
      { id: "deepseek-ai/DeepSeek-R1", name: "DeepSeek R1", reasoning: true, input: ["text"], contextWindow: 131072, maxTokens: 8192, cost: { input: 3, output: 7, cacheRead: 3, cacheWrite: 3 } },
    ],
  },
  // ── Fireworks ──
  {
    id: "fireworks",
    label: "Fireworks AI",
    description: "Fast inference — Kimi K2.5 Turbo",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    api: "openai-completions",
    placeholder: "...",
    defaultModel: "accounts/fireworks/routers/kimi-k2p5-turbo",
    models: [
      { id: "accounts/fireworks/routers/kimi-k2p5-turbo", name: "Kimi K2.5 Turbo (Fire Pass)", reasoning: false, input: ["text", "image"], contextWindow: 256000, maxTokens: 256000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ],
  },
  // ── Perplexity ──
  {
    id: "perplexity",
    label: "Perplexity",
    description: "Sonar — search-augmented AI",
    baseUrl: "https://api.perplexity.ai",
    api: "openai-completions",
    placeholder: "pplx-...",
    defaultModel: "sonar-pro",
    models: [
      { id: "sonar-pro", name: "Sonar Pro", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 8192, cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } },
      { id: "sonar", name: "Sonar", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8192, cost: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 } },
    ],
  },
  // ── Cohere ──
  {
    id: "cohere",
    label: "Cohere",
    description: "Command R+, Embed, Rerank",
    baseUrl: "https://api.cohere.com/v2",
    api: "openai-completions",
    placeholder: "...",
    defaultModel: "command-r-plus",
    models: [
      { id: "command-r-plus", name: "Command R+", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 } },
      { id: "command-r", name: "Command R", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 } },
    ],
  },
  // ── xAI (Grok) ──
  {
    id: "xai",
    label: "xAI (Grok)",
    description: "Grok 4, Grok 4 Fast, Grok 3",
    baseUrl: "https://api.x.ai/v1",
    api: "openai-responses",
    placeholder: "xai-...",
    defaultModel: "grok-4",
    models: [
      { id: "grok-4", name: "Grok 4", reasoning: true, input: ["text"], contextWindow: 256000, maxTokens: 64000, cost: { input: 3, output: 15, cacheRead: 0.75, cacheWrite: 0 } },
      { id: "grok-4-fast", name: "Grok 4 Fast", reasoning: true, input: ["text", "image"], contextWindow: 2000000, maxTokens: 30000, cost: { input: 0.2, output: 0.5, cacheRead: 0.05, cacheWrite: 0 } },
      { id: "grok-3-mini", name: "Grok 3 Mini", reasoning: true, input: ["text"], contextWindow: 131072, maxTokens: 8192, cost: { input: 0.3, output: 0.5, cacheRead: 0.075, cacheWrite: 0 } },
    ],
  },
  // ── MiniMax ──
  {
    id: "minimax",
    label: "MiniMax",
    description: "MiniMax M2.7 — powerful & affordable",
    baseUrl: "https://api.minimax.io/anthropic",
    api: "anthropic-messages",
    placeholder: "...",
    recommended: true,
    suggestion: "Try MiniMax — powerful models at affordable pricing",
    defaultModel: "MiniMax-M2.7",
    models: [
      { id: "MiniMax-M2.7", name: "MiniMax M2.7", reasoning: true, input: ["text", "image"], contextWindow: 204800, maxTokens: 131072, cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 } },
      { id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 Highspeed", reasoning: true, input: ["text", "image"], contextWindow: 204800, maxTokens: 131072, cost: { input: 0.6, output: 2.4, cacheRead: 0.06, cacheWrite: 0.375 } },
    ],
  },
  // ── Cerebras ──
  {
    id: "cerebras",
    label: "Cerebras",
    description: "Ultra-fast wafer-scale inference",
    baseUrl: "https://api.cerebras.ai/v1",
    api: "openai-completions",
    placeholder: "csk-...",
    defaultModel: "llama-3.3-70b",
    models: [
      { id: "llama-3.3-70b", name: "Llama 3.3 70B", reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 8192, cost: { input: 0.85, output: 1.2, cacheRead: 0, cacheWrite: 0 } },
    ],
  },
  // ── SambaNova ──
  {
    id: "sambanova",
    label: "SambaNova",
    description: "Fast open-source model inference",
    baseUrl: "https://api.sambanova.ai/v1",
    api: "openai-completions",
    placeholder: "...",
    defaultModel: "Meta-Llama-3.3-70B-Instruct",
    models: [
      { id: "Meta-Llama-3.3-70B-Instruct", name: "Llama 3.3 70B Instruct", reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ],
  },
  // ── Qwen ──
  {
    id: "qwen",
    label: "Qwen (Alibaba)",
    description: "Qwen 3.5 Plus, 3.6 Plus",
    baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
    api: "openai-completions",
    placeholder: "sk-...",
    defaultModel: "qwen3.5-plus",
    models: [
      { id: "qwen3.5-plus", name: "Qwen 3.5 Plus", reasoning: false, input: ["text", "image"], contextWindow: 1000000, maxTokens: 65536, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { id: "qwen3.6-plus", name: "Qwen 3.6 Plus", reasoning: false, input: ["text", "image"], contextWindow: 1000000, maxTokens: 65536, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ],
  },
];

export function getProvider(id: string): ProviderInfo | undefined {
  return PROVIDER_REGISTRY.find((p) => p.id === id);
}
