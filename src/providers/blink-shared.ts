/**
 * Blink provider constants for the Blink AI Gateway.
 *
 * The Blink provider routes all LLM calls through Blink's OpenAI-compatible
 * gateway at `${BLINK_APIS_URL}/api/v1/ai/chat/completions`. Authentication
 * uses a workspace API key (`blnk_ak_...`) injected as BLINK_API_KEY.
 *
 * Agent identity is sent separately via `x-blink-agent-id` header so that
 * blink-apis can track per-agent usage in Tinybird. The key itself is
 * workspace-scoped only (OpenAI `sk-...` pattern).
 *
 * Cost is set to 0 throughout — Blink's gateway handles billing externally
 * at 20% markup. OpenClaw must not attempt local cost tracking.
 */

const DEFAULT_BLINK_APIS_URL = "https://api.blink.new";

/** Base URL for the Blink AI Gateway chat completions endpoint. */
export function getBlinkGatewayBaseUrl(): string {
  const base = (process.env.BLINK_APIS_URL ?? DEFAULT_BLINK_APIS_URL).replace(/\/$/, "");
  return `${base}/api/v1/ai`;
}

export type BlinkModelCatalogEntry = {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
};

/** Zero cost — Blink gateway handles billing; OpenClaw must not track cost. */
export const BLINK_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;

/** The default model used when BLINK_API_KEY is set and no model is configured. */
export const BLINK_DEFAULT_MODEL_ID = "anthropic/claude-sonnet-4.6";

/**
 * Static model catalog — shown in the model selector UI.
 * Model IDs are in Vercel AI Gateway format (provider/model-id).
 * blink-apis' gateway() function accepts these IDs natively.
 */
export const BLINK_MODEL_CATALOG: BlinkModelCatalogEntry[] = [
  {
    id: "anthropic/claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: "openai/gpt-5-1",
    name: "GPT-5.1",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 128000,
    maxTokens: 32768,
  },
  {
    id: "google/gemini-3-flash",
    name: "Gemini 3 Flash",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 65536,
  },
];
