export const KILOCODE_BASE_URL = "https://api.kilo.ai/api/gateway/";
export const KILOCODE_DEFAULT_MODEL_ID = "anthropic/claude-opus-4.6";
export const KILOCODE_DEFAULT_MODEL_REF = `kilocode/${KILOCODE_DEFAULT_MODEL_ID}`;
export const KILOCODE_DEFAULT_MODEL_NAME = "Claude Opus 4.6";
export type KilocodeModelCatalogEntry = {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
};
export const KILOCODE_MODEL_CATALOG: KilocodeModelCatalogEntry[] = [
  {
    id: KILOCODE_DEFAULT_MODEL_ID,
    name: KILOCODE_DEFAULT_MODEL_NAME,
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 128000,
  },
  {
    id: "z-ai/glm-5:free",
    name: "GLM-5 (Free)",
    reasoning: true,
    input: ["text"],
    contextWindow: 202800,
    maxTokens: 131072,
  },
  {
    id: "minimax/minimax-m2.5:free",
    name: "MiniMax M2.5 (Free)",
    reasoning: true,
    input: ["text"],
    contextWindow: 204800,
    maxTokens: 131072,
  },
  {
    id: "anthropic/claude-sonnet-4.5",
    name: "Claude Sonnet 4.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 64000,
  },
  {
    id: "openai/gpt-5.2",
    name: "GPT-5.2",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 400000,
    maxTokens: 128000,
  },
  {
    id: "google/gemini-3-pro-preview",
    name: "Gemini 3 Pro Preview",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "google/gemini-3-flash-preview",
    name: "Gemini 3 Flash Preview",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65535,
  },
  {
    id: "x-ai/grok-code-fast-1",
    name: "Grok Code Fast 1",
    reasoning: true,
    input: ["text"],
    contextWindow: 256000,
    maxTokens: 10000,
  },
  {
    id: "moonshotai/kimi-k2.5",
    name: "Kimi K2.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 65535,
  },
];
export const KILOCODE_DEFAULT_CONTEXT_WINDOW = 1000000;
export const KILOCODE_DEFAULT_MAX_TOKENS = 128000;
export const KILOCODE_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;
