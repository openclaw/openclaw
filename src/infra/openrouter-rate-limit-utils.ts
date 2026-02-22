/**
 * OpenRouter rate limit and credit utilities.
 *
 * OpenRouter differs from Anthropic:
 *   - Credit-based (not token-bucket ITPM/OTPM)
 *   - Per-model rate limits (not global)
 *   - Cloudflare DDoS protection (implicit, not header-advertised)
 *   - Free models: 20 RPM hard cap, limited daily requests
 *   - GET /api/v1/key → { data: { limit_remaining, usage, rate_limit } }
 *
 * Design: This module is stateless — callers pass state in/out.
 * The orchestrator holds the mutable CreditState between calls.
 */

// ── Types ────────────────────────────────────────────────────

export interface OpenRouterKeyInfo {
  /** Remaining credit in USD (null if unlimited / pay-as-you-go) */
  limitRemaining: number | null;
  /** Daily spend in USD */
  usageDaily: number;
  /** Weekly spend in USD */
  usageWeekly: number;
  /** Monthly spend in USD */
  usageMonthly: number;
  /** Per-model rate limit info (if returned) */
  rateLimit?: {
    requests: number;
    interval: string; // e.g. "10s"
  };
  /** Timestamp of this reading */
  fetchedAt: Date;
}

export interface OpenRouterCreditState {
  /** Last known credit balance */
  credits: number | null;
  /** Estimated cost consumed in current batch */
  batchSpend: number;
  /** Timestamp of last credit check */
  lastCheckedAt: Date | null;
  /** Per-model request counts in current batch (for free-model caps) */
  modelRequestCounts: Record<string, number>;
}

export interface OpenRouterModelProfile {
  /** Requests per minute (null = no known hard limit) */
  rpm: number | null;
  /** Whether this is a free-tier model */
  isFree: boolean;
  /** Cost per 1M input tokens in USD */
  inputPricePerMillion: number;
  /** Cost per 1M output tokens in USD */
  outputPricePerMillion: number;
}

// ── Known Model Profiles ────────────────────────────────────

/**
 * Known model rate profiles on OpenRouter.
 * Updated manually; OpenRouter doesn't expose this via API consistently.
 */
export const OPENROUTER_MODEL_PROFILES: Record<string, OpenRouterModelProfile> = {
  "moonshotai/kimi-k2.5": {
    rpm: null, // credit-based, no hard RPM
    isFree: false,
    inputPricePerMillion: 0.15,
    outputPricePerMillion: 0.6,
  },
  "anthropic/claude-haiku-4-5-20251001": {
    rpm: null,
    isFree: false,
    inputPricePerMillion: 1.0,
    outputPricePerMillion: 5.0,
  },
  "anthropic/claude-sonnet-4-5-20250514": {
    rpm: null,
    isFree: false,
    inputPricePerMillion: 4.0,
    outputPricePerMillion: 20.0,
  },
  "deepseek/deepseek-r1": {
    rpm: null,
    isFree: false,
    inputPricePerMillion: 0.55,
    outputPricePerMillion: 2.19,
  },
  // Free models have hard 20 RPM cap
  "meta-llama/llama-3.3-8b-instruct:free": {
    rpm: 20,
    isFree: true,
    inputPricePerMillion: 0,
    outputPricePerMillion: 0,
  },
};

// ── Credit Checking ─────────────────────────────────────────

/**
 * Fetch current credit/usage info from OpenRouter.
 * Call this before a batch and between waves.
 *
 * @param apiKey OpenRouter API key
 * @param baseUrl API base (default: https://openrouter.ai)
 */
export async function fetchOpenRouterKeyInfo(
  apiKey: string,
  baseUrl = "https://openrouter.ai",
): Promise<OpenRouterKeyInfo> {
  const res = await fetch(`${baseUrl}/api/v1/key`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    throw new Error(`OpenRouter /api/v1/key failed: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as {
    data?: {
      limit_remaining?: number | null;
      usage?: number;
      rate_limit?: { requests?: number; interval?: string };
      // Alternate shape — usage breakdown
      limit?: number;
      usage_daily?: number;
      usage_weekly?: number;
      usage_monthly?: number;
    };
  };

  const d = json.data ?? {};

  return {
    limitRemaining: d.limit_remaining ?? null,
    usageDaily: d.usage_daily ?? d.usage ?? 0,
    usageWeekly: d.usage_weekly ?? 0,
    usageMonthly: d.usage_monthly ?? 0,
    rateLimit: d.rate_limit?.requests
      ? { requests: d.rate_limit.requests, interval: d.rate_limit.interval ?? "10s" }
      : undefined,
    fetchedAt: new Date(),
  };
}

// ── Credit State Management ─────────────────────────────────

export function createCreditState(): OpenRouterCreditState {
  return {
    credits: null,
    batchSpend: 0,
    lastCheckedAt: null,
    modelRequestCounts: {},
  };
}

/**
 * Update credit state after a key info fetch.
 */
export function updateCreditState(
  state: OpenRouterCreditState,
  info: OpenRouterKeyInfo,
): OpenRouterCreditState {
  return {
    ...state,
    credits: info.limitRemaining,
    lastCheckedAt: info.fetchedAt,
  };
}

/**
 * Record a completed request against credit state.
 */
export function recordRequest(
  state: OpenRouterCreditState,
  model: string,
  estimatedCostUsd: number,
): OpenRouterCreditState {
  const counts = { ...state.modelRequestCounts };
  counts[model] = (counts[model] ?? 0) + 1;
  return {
    ...state,
    batchSpend: state.batchSpend + estimatedCostUsd,
    credits: state.credits !== null ? state.credits - estimatedCostUsd : null,
    modelRequestCounts: counts,
  };
}

// ── Decision Functions ──────────────────────────────────────

/**
 * Check if we have sufficient credits for an estimated batch cost.
 * Returns { ok, message }.
 */
export function checkCreditSufficiency(
  state: OpenRouterCreditState,
  estimatedBatchCostUsd: number,
): { ok: boolean; message: string } {
  if (state.credits === null) {
    return { ok: true, message: "Credit balance unknown (pay-as-you-go or unlimited)." };
  }
  if (state.credits >= estimatedBatchCostUsd) {
    return {
      ok: true,
      message: `Credits sufficient: $${state.credits.toFixed(2)} available, ~$${estimatedBatchCostUsd.toFixed(2)} needed.`,
    };
  }
  return {
    ok: false,
    message: `Insufficient credits: $${state.credits.toFixed(2)} available, ~$${estimatedBatchCostUsd.toFixed(2)} needed. Top up at https://openrouter.ai/credits`,
  };
}

/**
 * Recommend spawn delay for a given model on OpenRouter.
 *
 * - Free models: 3s minimum (20 RPM cap → 3s/request to stay safe)
 * - Paid models: 5s default (Cloudflare avoidance)
 * - If credits are low (<$5): 8s (slow down to conserve)
 */
export function recommendOpenRouterDelay(
  model: string,
  state: OpenRouterCreditState,
  configDelayMs = 5000,
): number {
  const profile = getModelProfile(model);

  // Free models: enforce 3s minimum (20 RPM = 3s/req)
  if (profile.isFree) {
    return Math.max(3000, configDelayMs);
  }

  // Low credits: slow down
  if (state.credits !== null && state.credits < 5) {
    return Math.max(8000, configDelayMs);
  }

  return configDelayMs;
}

/**
 * Check if a free model has exceeded its daily request budget.
 * Free models on OpenRouter have ~200 requests/day (varies).
 */
export function isFreeModelExhausted(
  model: string,
  state: OpenRouterCreditState,
  dailyLimit = 200,
): boolean {
  const profile = getModelProfile(model);
  if (!profile.isFree) {
    return false;
  }
  return (state.modelRequestCounts[model] ?? 0) >= dailyLimit;
}

/**
 * Should we refresh credit info? (Stale after 5 minutes or between waves.)
 */
export function shouldRefreshCredits(
  state: OpenRouterCreditState,
  staleAfterMs = 5 * 60 * 1000,
): boolean {
  if (!state.lastCheckedAt) {
    return true;
  }
  return Date.now() - state.lastCheckedAt.getTime() > staleAfterMs;
}

/**
 * Estimate cost for a task in USD.
 */
export function estimateTaskCostUsd(
  model: string,
  estimatedInputTokens: number,
  estimatedOutputTokens: number,
): number {
  const profile = getModelProfile(model);
  const inputCost = (estimatedInputTokens / 1_000_000) * profile.inputPricePerMillion;
  const outputCost = (estimatedOutputTokens / 1_000_000) * profile.outputPricePerMillion;
  return inputCost + outputCost;
}

/**
 * Get model profile, falling back to conservative defaults.
 */
export function getModelProfile(model: string): OpenRouterModelProfile {
  // Try exact match, then check if model string contains a known key
  if (OPENROUTER_MODEL_PROFILES[model]) {
    return OPENROUTER_MODEL_PROFILES[model];
  }
  for (const [key, profile] of Object.entries(OPENROUTER_MODEL_PROFILES)) {
    if (model.includes(key) || key.includes(model)) {
      return profile;
    }
  }
  // Conservative fallback
  return {
    rpm: null,
    isFree: false,
    inputPricePerMillion: 1.0,
    outputPricePerMillion: 5.0,
  };
}

// ── Cloudflare Detection ────────────────────────────────────

import { type ProviderType } from "./provider-types.js";

/**
 * Detect if an error is from Cloudflare DDoS protection (not a real API error).
 * Cloudflare returns HTML pages with specific markers.
 */
export function isCloudflareBlock(err: unknown): boolean {
  const msg = String(err);
  return (
    /cloudflare/i.test(msg) ||
    /cf-ray/i.test(msg) ||
    /challenge-platform/i.test(msg) ||
    /403.*cloudflare/i.test(msg) ||
    /1020.*access denied/i.test(msg)
  );
}

/**
 * Recommend backoff after a Cloudflare block.
 * Cloudflare blocks are typically 60s, but can be longer.
 */
export function cloudflareBackoffMs(consecutiveBlocks: number): number {
  // 60s, 120s, 240s — double each time, cap at 5 minutes
  return Math.min(60_000 * Math.pow(2, consecutiveBlocks), 300_000);
}

// ── Provider Detection ──────────────────────────────────────

/**
 * Detect provider from model string or base URL.
 * Used to select the right retry runner and rate limit strategy.
 */
export function detectProvider(model: string, baseUrl?: string): ProviderType {
  if (baseUrl) {
    if (/openrouter\.ai/i.test(baseUrl)) {
      return "openrouter";
    }
    if (/anthropic\.com/i.test(baseUrl)) {
      return "anthropic";
    }
    if (/localhost|127\.0\.0\.1|ollama/i.test(baseUrl)) {
      return "local";
    }
  }
  // Model string heuristics
  if (/^openrouter\//i.test(model)) {
    return "openrouter";
  }
  if (/^anthropic\//i.test(model)) {
    return "anthropic";
  }
  if (/^ollama\//i.test(model) || model === "qwen-local") {
    return "local";
  }
  // Models routed through OpenRouter typically have org/ prefix
  if (/^(moonshotai|deepseek|meta-llama|google|mistralai)\//i.test(model)) {
    return "openrouter";
  }
  return "unknown";
}
