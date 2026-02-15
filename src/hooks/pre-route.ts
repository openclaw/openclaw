/**
 * pre-route.ts — Lightweight LLM-based message router
 *
 * Makes a single LLM call with ONLY the user's message + a tiny
 * classification prompt (~300 tokens total). Returns a model reference
 * string that OpenClaw uses for the actual agent run.
 *
 * Supports two provider modes:
 *   - "ollama" (default): Local Ollama instance
 *   - "openai-compatible": Any OpenAI-compatible API (OpenRouter, etc.)
 *
 * This runs BEFORE system prompt assembly, tool loading, or any of
 * the heavy context injection. The router model never sees any of that.
 *
 * Install: Drop into src/hooks/ and wire into the reply handler.
 * Config: Add `router` section to openclaw.json (see below).
 */

import fs from "node:fs";
import path from "node:path";
import { type OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RouterConfig {
  /** Enable/disable the router. Default: false */
  enabled: boolean;

  /** Provider type. Default: "ollama" */
  provider?: "ollama" | "openai-compatible";

  /** Base URL for the provider. Ollama default: "http://localhost:11434" */
  baseUrl?: string;

  /** API key. Supports "env:VAR_NAME" syntax to read from environment. */
  apiKey?: string;

  /** Model to use for classification. Default: "qwen3:4b-instruct-2507-q4_K_M" */
  model?: string;

  /** Timeout in ms for the classification call. Default: 10000 (10s) */
  timeoutMs?: number;

  /**
   * Routing table: maps tier labels to OpenClaw model references.
   * The local model outputs one of these tier names.
   *
   * Example:
   *   { "1": "minimax/MiniMax-Text-01",
   *     "2": "anthropic/claude-haiku-4-5-20251001",
   *     "3": "anthropic/claude-opus-4-6" }
   */
  tiers: Record<string, string>;

  /** Default tier if classification fails or is unrecognized. */
  defaultTier: string;
}

export interface RouteResult {
  /** The tier label returned by the classifier (e.g. "code") */
  tier: string;

  /** The resolved OpenClaw model reference (e.g. "anthropic/claude-haiku-4-5-20251001") */
  modelRef: string;

  /** Classification latency in ms */
  latencyMs: number;

  /** Whether this was a fallback (classification failed or unrecognized) */
  fallback: boolean;
}

// ---------------------------------------------------------------------------
// Default classification prompt
// ---------------------------------------------------------------------------

const ROUTER_PROMPT = `Classify the message into category 1, 2, or 3. Reply with ONLY the number.
1 = casual (greetings, simple questions, small talk, quick tasks, simple tool use like reading/checking/listing files, looking things up, basic commands)
2 = code (writing new code, debugging errors, scripts, code review, refactoring, technical problem-solving)
3 = complex (architecture, planning, deep analysis, reports, essays, multi-step research)

If previous messages are shown in brackets, use them to understand references (e.g., "yes, fix that" or "do it"). But if the current message is a clearly self-contained request (e.g., "give me a poem", "what time is it"), classify it on its own merits — don't escalate just because the prior conversation was complex.

"hey" → 1
"fix this TypeError" → 2
"design a system" → 3
"what time is it" → 1
"write a python function" → 2
"compare approaches in detail" → 3
"thanks" → 1
"review my PR" → 2
"plan a new project" → 3
"read that file back to me" → 1
"check if this file exists" → 1
"show me the contents of config.json" → 1
"list the files in this directory" → 1
"look at the docs" → 1
"what's in my memory" → 1
"yes, fix that" (after discussing a bug) → 2
"do it" (after discussing architecture) → 3
"give me a poem" (after discussing code) → 1
"sounds good" → 1

Reply ONLY the number.`;

// ---------------------------------------------------------------------------
// Prompt resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the router classification prompt.
 * 1. ~/.openclaw/router/ROUTER.md (if exists and has content)
 * 2. Built-in ROUTER_PROMPT constant
 */
function resolveRouterPrompt(): string {
  try {
    const filePath = path.join(resolveStateDir(), "router", "ROUTER.md");
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf8").trim();
      if (content) return content;
    }
  } catch {
    /* ignore */
  }
  return ROUTER_PROMPT;
}

// ---------------------------------------------------------------------------
// API key resolution
// ---------------------------------------------------------------------------

function resolveApiKey(apiKey: string | undefined): string | undefined {
  if (!apiKey) return undefined;
  if (apiKey.startsWith("env:")) {
    return process.env[apiKey.slice(4)] ?? undefined;
  }
  return apiKey;
}

// ---------------------------------------------------------------------------
// Router implementation
// ---------------------------------------------------------------------------

/**
 * Parse the raw classifier response text into a tier match.
 */
function parseTierFromResponse(
  raw: string,
  tiers: Record<string, string>,
): { tier: string; modelRef: string } | null {
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9]/g, "");

  // Match first character against tier keys (e.g. 1, 2, 3)
  const firstChar = cleaned.charAt(0);
  if (firstChar && tiers[firstChar]) {
    return { tier: firstChar, modelRef: tiers[firstChar] };
  }

  // Fallback: check if response contains any tier key
  const tierNames = Object.keys(tiers);
  const matchedTier = tierNames.find((t) => cleaned.includes(t));
  if (matchedTier) {
    return { tier: matchedTier, modelRef: tiers[matchedTier] };
  }

  return null;
}

/**
 * Call Ollama's /api/generate endpoint.
 */
async function callOllama(
  baseUrl: string,
  model: string,
  systemPrompt: string,
  message: string,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const response = await fetch(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      system: systemPrompt,
      prompt: message,
      stream: false,
      think: false,
      options: {
        num_predict: 8,
        temperature: 0.0,
        top_k: 1,
        num_ctx: 1024,
        stop: ["\n", ".", ",", " "],
      },
    }),
    signal: controller.signal,
  });

  clearTimeout(timer);

  if (!response.ok) {
    throw new Error(`Ollama returned ${response.status}`);
  }

  const data = (await response.json()) as { response: string };
  return data.response;
}

/**
 * Call an OpenAI-compatible /chat/completions endpoint.
 */
async function callOpenAICompatible(
  baseUrl: string,
  model: string,
  systemPrompt: string,
  message: string,
  timeoutMs: number,
  apiKey?: string,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
      ],
      max_tokens: 8,
      temperature: 0.0,
    }),
    signal: controller.signal,
  });

  clearTimeout(timer);

  if (!response.ok) {
    throw new Error(`OpenAI-compatible API returned ${response.status}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  return data.choices[0]?.message?.content ?? "";
}

/**
 * Classify a user message by calling an LLM (Ollama or OpenAI-compatible).
 * Returns the tier and resolved model reference.
 */
export async function routeMessage(
  message: string,
  config: RouterConfig,
  recentContext?: string[],
): Promise<RouteResult> {
  const start = Date.now();
  const provider = config.provider ?? "ollama";
  const baseUrl =
    config.baseUrl ?? (provider === "ollama" ? "http://localhost:11434" : undefined);
  const model = config.model ?? "qwen3:4b-instruct-2507-q4_K_M";
  const timeoutMs = config.timeoutMs ?? 10_000;
  const systemPrompt = resolveRouterPrompt();
  const resolvedApiKey = resolveApiKey(config.apiKey);

  // Prepend conversation context so the classifier can see the topic
  const MAX_CONTEXT_CHARS = 200;
  let classifierInput = message;
  if (recentContext && recentContext.length > 0) {
    const contextLines = recentContext.map((msg) => {
      const truncated = msg.length > MAX_CONTEXT_CHARS ? msg.slice(0, MAX_CONTEXT_CHARS) + "…" : msg;
      return `[Previous: ${truncated}]`;
    });
    classifierInput = contextLines.join("\n") + "\n\n" + message;
  }

  if (!baseUrl) {
    console.warn("[pre-route] No baseUrl configured for openai-compatible provider, falling back to default tier");
    return {
      tier: config.defaultTier,
      modelRef: config.tiers[config.defaultTier],
      latencyMs: Date.now() - start,
      fallback: true,
    };
  }

  try {
    const raw =
      provider === "openai-compatible"
        ? await callOpenAICompatible(baseUrl, model, systemPrompt, classifierInput, timeoutMs, resolvedApiKey)
        : await callOllama(baseUrl, model, systemPrompt, classifierInput, timeoutMs);

    const latencyMs = Date.now() - start;

    const match = parseTierFromResponse(raw, config.tiers);
    if (match) {
      return { ...match, latencyMs, fallback: false };
    }

    // Unrecognized output — use default
    const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    console.warn(
      `[pre-route] Unrecognized tier "${cleaned}" from ${provider} model, using default "${config.defaultTier}"`,
    );
    return {
      tier: config.defaultTier,
      modelRef: config.tiers[config.defaultTier],
      latencyMs,
      fallback: true,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const errMsg = err instanceof Error ? err.message : String(err);

    // On any failure (timeout, connection refused, etc), fall back to default
    console.warn(
      `[pre-route] Classification failed (${errMsg}), using default "${config.defaultTier}"`,
    );
    return {
      tier: config.defaultTier,
      modelRef: config.tiers[config.defaultTier],
      latencyMs,
      fallback: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Config resolver
// ---------------------------------------------------------------------------

/**
 * Extract router config from openclaw.json.
 * Expected location: config.router (top-level)
 *
 * Returns null if router is not configured or disabled.
 */
export function resolveRouterConfig(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: OpenClawConfig | Record<string, any>,
): RouterConfig | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const router = (config as any).router;
  if (!router || router.enabled === false) return null;

  if (!router.tiers || typeof router.tiers !== "object") {
    console.warn("[pre-route] Router enabled but no tiers configured, disabling");
    return null;
  }

  if (!router.defaultTier || !router.tiers[router.defaultTier]) {
    console.warn("[pre-route] Router defaultTier missing or not in tiers, disabling");
    return null;
  }

  return {
    enabled: true,
    provider: router.provider,
    baseUrl: router.baseUrl,
    apiKey: router.apiKey,
    model: router.model,
    timeoutMs: router.timeoutMs,
    tiers: router.tiers,
    defaultTier: router.defaultTier,
  };
}

// ---------------------------------------------------------------------------
// parseModelRef helper (matches OpenClaw convention: "provider/modelId")
// ---------------------------------------------------------------------------

export function parseRoutedModelRef(modelRef: string): {
  provider: string;
  model: string;
} {
  const slash = modelRef.indexOf("/");
  if (slash === -1) {
    return { provider: "anthropic", model: modelRef };
  }
  return {
    provider: modelRef.slice(0, slash),
    model: modelRef.slice(slash + 1),
  };
}
