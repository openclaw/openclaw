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
 *
 * Model catalog: fetched dynamically from /api/v1/ai/models at startup.
 * Falls back to BLINK_MODEL_CATALOG_STATIC if fetch fails.
 */

const DEFAULT_BLINK_APIS_URL = "https://core.blink.new";

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
 * Static fallback catalog — used when the gateway fetch fails at startup.
 * Keep model IDs in sync with what the gateway actually returns.
 */
export const BLINK_MODEL_CATALOG_STATIC: BlinkModelCatalogEntry[] = [
  { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6", reasoning: false, input: ["text", "image"], contextWindow: 200000, maxTokens: 64000 },
  { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5", reasoning: false, input: ["text", "image"], contextWindow: 200000, maxTokens: 64000 },
  { id: "anthropic/claude-haiku-4.5", name: "Claude Haiku 4.5", reasoning: false, input: ["text", "image"], contextWindow: 200000, maxTokens: 16000 },
  { id: "anthropic/claude-opus-4.5", name: "Claude Opus 4.5", reasoning: false, input: ["text", "image"], contextWindow: 200000, maxTokens: 32000 },
  { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet", reasoning: false, input: ["text", "image"], contextWindow: 200000, maxTokens: 8192 },
  { id: "anthropic/claude-3.5-haiku", name: "Claude 3.5 Haiku", reasoning: false, input: ["text", "image"], contextWindow: 200000, maxTokens: 8192 },
  { id: "openai/gpt-5.2", name: "GPT-5.2", reasoning: false, input: ["text", "image"], contextWindow: 1047576, maxTokens: 32768 },
  { id: "openai/gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini", reasoning: false, input: ["text"], contextWindow: 1047576, maxTokens: 32768 },
  { id: "openai/gpt-4o", name: "GPT-4o", reasoning: false, input: ["text", "image"], contextWindow: 128000, maxTokens: 16384 },
  { id: "openai/gpt-4o-mini", name: "GPT-4o mini", reasoning: false, input: ["text", "image"], contextWindow: 128000, maxTokens: 16384 },
  { id: "openai/o4-mini", name: "o4-mini", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 65536 },
  { id: "openai/o3", name: "o3", reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 100000 },
  { id: "google/gemini-3-flash", name: "Gemini 3 Flash", reasoning: false, input: ["text", "image"], contextWindow: 1000000, maxTokens: 65536 },
  { id: "google/gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite", reasoning: false, input: ["text", "image"], contextWindow: 1000000, maxTokens: 65536 },
  { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", reasoning: true, input: ["text", "image"], contextWindow: 1000000, maxTokens: 65536 },
  { id: "google/gemini-2.0-flash", name: "Gemini 2.0 Flash", reasoning: false, input: ["text", "image"], contextWindow: 1000000, maxTokens: 65536 },
];

type GatewayModelEntry = { id: string; name: string };

/** Cached model catalog — populated once by fetchBlinkModelCatalog(). */
let _cachedCatalog: BlinkModelCatalogEntry[] | null = null;

/** Convert a gateway entry to OpenClaw catalog format. */
function fromGatewayEntry(m: GatewayModelEntry): BlinkModelCatalogEntry {
  const reasoning = /\/o[1-9]\b|\/o3\b|\/o4|-thinking/.test(m.id);
  return {
    id: m.id,
    name: m.name,
    reasoning,
    input: ["text"],
    contextWindow: 200000,
    maxTokens: 65536,
  };
}

/**
 * Fetch the full language model catalog from the Blink gateway.
 * Cached in memory — called once at startup in buildBlinkProvider().
 * Falls back to BLINK_MODEL_CATALOG_STATIC on network error.
 */
export async function fetchBlinkModelCatalog(): Promise<BlinkModelCatalogEntry[]> {
  if (_cachedCatalog) return _cachedCatalog;

  const base = (process.env.BLINK_APIS_URL ?? DEFAULT_BLINK_APIS_URL).replace(/\/$/, "");
  const url = `${base}/api/v1/ai/models`;

  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  const body = await res.json() as { data: GatewayModelEntry[] };
  _cachedCatalog = body.data.map(fromGatewayEntry);
  return _cachedCatalog;
}

/**
 * Active model catalog — starts as static fallback.
 * buildBlinkProvider() replaces this with the fetched catalog.
 */
export let BLINK_MODEL_CATALOG: BlinkModelCatalogEntry[] = BLINK_MODEL_CATALOG_STATIC;
