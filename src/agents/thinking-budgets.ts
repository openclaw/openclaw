import type { ThinkLevel } from "../auto-reply/thinking.js";

/**
 * Token budget allocation for reasoning/thinking per model and thinking level.
 * These values represent the approximate number of tokens consumed during the
 * model's internal reasoning phase before generating output.
 *
 * Based on analysis as of February 2026:
 * - GPT-5.2: Token-efficient but can be "lazy" at medium; consider high for accuracy
 * - Gemini 3 Pro: More verbose, excellent for deep reasoning
 * - Gemini 3 Flash: Cost-effective and predictable
 * - Claude (via SDK): Uses higher budgets for extended thinking
 *
 * Source: Gemini Pro analysis + empirical testing (2026-02)
 */
export type ThinkingBudget = {
  /** No reasoning/thinking (fast, direct response) */
  off: number;
  /** Minimal reasoning (~1-2k tokens) - sanity checks, formatting */
  minimal: number;
  /** Low reasoning (~1.5-2k tokens) - classification, simple routing */
  low: number;
  /** Medium reasoning (~3-8k tokens) - standard coding, single-step logic */
  medium: number;
  /** High reasoning (~8-24k tokens) - complex refactoring, multi-constraint planning */
  high: number;
  /** Extra-high reasoning (25k+ tokens) - deep research, architecture, math proofs */
  xhigh: number;
};

/**
 * Provider-specific thinking budget mappings.
 * Key format: "provider/model" (e.g., "openai/gpt-5.2")
 */
export type ThinkingBudgetMap = Record<string, ThinkingBudget>;

/**
 * Default thinking budgets per provider/model.
 * These are constants for now but structured for easy configuration later.
 */
export const DEFAULT_THINKING_BUDGETS: ThinkingBudgetMap = {
  // OpenAI GPT-5.2 (Codex)
  "openai/gpt-5.2": {
    off: 0,
    minimal: 0, // GPT-5.2 supports "minimal" = no reasoning
    low: 1_500,
    medium: 4_000,
    high: 10_000,
    xhigh: 25_000,
  },
  "openai-codex/gpt-5.2": {
    off: 0,
    minimal: 0,
    low: 1_500,
    medium: 4_000,
    high: 10_000,
    xhigh: 25_000,
  },
  "openai-codex/gpt-5.2-codex": {
    off: 0,
    minimal: 0,
    low: 1_500,
    medium: 4_000,
    high: 10_000,
    xhigh: 25_000,
  },
  "openai-codex/gpt-5.1-codex": {
    off: 0,
    minimal: 0,
    low: 2_000, // 5.1 is slightly less efficient than 5.2
    medium: 5_000,
    high: 12_000,
    xhigh: 30_000,
  },

  // OpenAI GPT-5 Mini
  "openai/gpt-5-mini": {
    off: 0,
    minimal: 0,
    low: 1_000,
    medium: 2_500,
    high: 6_000,
    xhigh: 15_000,
  },

  // Google Gemini 3 Pro
  "google/gemini-3-pro": {
    off: 0,
    minimal: 500,
    low: 2_000,
    medium: 8_000,
    high: 20_000,
    xhigh: 64_000,
  },
  "google/gemini-3-pro-preview": {
    off: 0,
    minimal: 500,
    low: 2_000,
    medium: 8_000,
    high: 20_000,
    xhigh: 64_000,
  },

  // Google Gemini 3 Flash
  "google/gemini-3-flash": {
    off: 0,
    minimal: 500,
    low: 1_500,
    medium: 5_000,
    high: 12_000,
    xhigh: 32_000,
  },
  "google/gemini-3-flash-preview": {
    off: 0,
    minimal: 500,
    low: 1_500,
    medium: 5_000,
    high: 12_000,
    xhigh: 32_000,
  },

  // Claude via SDK (higher budgets for extended thinking)
  "anthropic/claude-opus-4-5": {
    off: 0,
    minimal: 1_000,
    low: 10_000,
    medium: 25_000,
    high: 50_000,
    xhigh: 50_000, // SDK max
  },
  "anthropic/claude-sonnet-4-5": {
    off: 0,
    minimal: 1_000,
    low: 10_000,
    medium: 25_000,
    high: 50_000,
    xhigh: 50_000,
  },
  "anthropic/claude-opus-4": {
    off: 0,
    minimal: 1_000,
    low: 8_000,
    medium: 20_000,
    high: 40_000,
    xhigh: 40_000,
  },
  "anthropic/claude-sonnet-4": {
    off: 0,
    minimal: 1_000,
    low: 8_000,
    medium: 20_000,
    high: 40_000,
    xhigh: 40_000,
  },

  // z.AI GLM-4.7
  "zai/glm-4.7": {
    off: 0,
    minimal: 500,
    low: 5_000,
    medium: 15_000,
    high: 30_000,
    xhigh: 30_000,
  },
};

/**
 * Fallback budget for unknown models.
 * Conservative estimates to avoid context overflow.
 */
const FALLBACK_THINKING_BUDGET: ThinkingBudget = {
  off: 0,
  minimal: 500,
  low: 2_000,
  medium: 5_000,
  high: 10_000,
  xhigh: 20_000,
};

/**
 * Normalize model key for lookup.
 * Handles various formats: "provider/model", "model", etc.
 */
function normalizeModelKey(provider: string, model: string): string {
  const normalizedProvider = provider.toLowerCase().trim();
  const normalizedModel = model.toLowerCase().trim();

  // If model already includes provider, use as-is
  if (normalizedModel.includes("/")) {
    return normalizedModel;
  }

  // Construct provider/model key
  return `${normalizedProvider}/${normalizedModel}`;
}

/**
 * Resolve thinking token budget for a given provider, model, and thinking level.
 *
 * @param provider - Provider ID (e.g., "openai", "anthropic", "google")
 * @param model - Model ID (e.g., "gpt-5.2", "claude-opus-4-5")
 * @param thinkLevel - Thinking level (off, minimal, low, medium, high, xhigh)
 * @returns Token budget for the specified configuration
 *
 * @example
 * ```typescript
 * const budget = resolveThinkingTokenBudget("openai-codex", "gpt-5.2", "medium");
 * // Returns: 4000
 * ```
 */
export function resolveThinkingTokenBudget(
  provider: string,
  model: string,
  thinkLevel: ThinkLevel,
): number {
  // Handle "off" early
  if (thinkLevel === "off") {
    return 0;
  }

  const modelKey = normalizeModelKey(provider, model);
  const budgetMap = DEFAULT_THINKING_BUDGETS[modelKey];

  if (budgetMap) {
    return budgetMap[thinkLevel];
  }

  // Fallback for unknown models
  return FALLBACK_THINKING_BUDGET[thinkLevel];
}

/**
 * Check if a thinking budget would conflict with available context window space.
 *
 * @param thinkingBudget - Proposed thinking token budget
 * @param contextWindow - Total context window size for the model
 * @param usedTokens - Tokens already used (prompt + history)
 * @param reserveTokens - Additional tokens to reserve (e.g., for output, compaction buffer)
 * @returns Object with conflict status and available space
 *
 * @example
 * ```typescript
 * const check = checkThinkingBudgetConflict(25_000, 128_000, 80_000, 20_000);
 * if (check.hasConflict) {
 *   console.warn(`Insufficient space: need ${check.needed}, have ${check.available}`);
 * }
 * ```
 */
export function checkThinkingBudgetConflict(params: {
  thinkingBudget: number;
  contextWindow: number;
  usedTokens: number;
  reserveTokens: number;
}): {
  hasConflict: boolean;
  available: number;
  needed: number;
  recommendation?: ThinkLevel;
} {
  const { thinkingBudget, contextWindow, usedTokens, reserveTokens } = params;

  const totalNeeded = usedTokens + reserveTokens + thinkingBudget;
  const available = contextWindow - usedTokens - reserveTokens;
  const hasConflict = totalNeeded > contextWindow;

  // Suggest a lower thinking level if there's a conflict
  let recommendation: ThinkLevel | undefined;
  if (hasConflict && available > 0) {
    // Find the highest thinking level that fits
    if (available >= 20_000) recommendation = "high";
    else if (available >= 8_000) recommendation = "medium";
    else if (available >= 2_000) recommendation = "low";
    else if (available >= 500) recommendation = "minimal";
    else recommendation = "off";
  }

  return {
    hasConflict,
    available,
    needed: thinkingBudget,
    recommendation,
  };
}

/**
 * Get all supported models with thinking budgets.
 * Useful for configuration UI or validation.
 */
export function getSupportedModelsWithBudgets(): Array<{
  key: string;
  budgets: ThinkingBudget;
}> {
  return Object.entries(DEFAULT_THINKING_BUDGETS).map(([key, budgets]) => ({
    key,
    budgets,
  }));
}
