/**
 * Token Budget Routing — Type Definitions
 *
 * Enables tiered model routing based on daily token budgets.
 * Users can exhaust free-tier allowances (e.g. OpenAI's free codex tokens)
 * before falling back to their primary (paid) model.
 */

/** A single budget tier: one model with a daily token cap. */
export type TokenBudgetTier = {
  /** Provider identifier, e.g. "openai". */
  provider: string;
  /** Model identifier, e.g. "gpt-5.1-codex". */
  model: string;
  /** Maximum tokens (input + output) allowed per day for this tier. */
  dailyTokenLimit: number;
};

/** Top-level config section for token budget routing. */
export type TokenBudgetConfig = {
  /** Master switch. When false/undefined, routing is bypassed. */
  enabled?: boolean;
  /**
   * Ordered list of budget tiers. Tiers are tried in order; the first
   * non-exhausted tier is used. When all tiers are exhausted the
   * configured primary model is used as the final fallback.
   */
  tiers: TokenBudgetTier[];
  /**
   * When the daily budget resets.
   * - "midnight-local" (default): resets at 00:00 in the system's local timezone.
   * - "midnight-utc": resets at 00:00 UTC.
   */
  resetTime?: "midnight-local" | "midnight-utc";
};

/** Per-day usage counters persisted to disk. */
export type TokenBudgetDayUsage = {
  /** Date string in "YYYY-MM-DD" format (local or UTC depending on resetTime). */
  date: string;
  /** Token usage per tier, keyed by "provider/model". */
  tiers: Record<string, number>;
};

/** Root structure of the persisted budget state file. */
export type TokenBudgetState = {
  /** Schema version for forward compatibility. */
  version: 1;
  /** Current day's usage counters. */
  usage: TokenBudgetDayUsage;
};
