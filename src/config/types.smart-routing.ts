/**
 * Smart model routing configuration.
 *
 * Automatically selects the most cost-efficient model tier based on
 * message complexity using a hybrid approach: fast regex patterns for
 * obvious cases, optional lightweight LLM classification for ambiguous ones.
 *
 * @see https://github.com/openclaw/openclaw/issues/53516
 */
export type SmartRoutingConfig = {
  /** Enable smart model routing. Default: false. */
  enabled?: boolean;

  /**
   * Model tiers keyed by complexity level.
   * Each tier maps to a provider/model string (e.g. "anthropic/claude-haiku-4-5").
   *
   * If a tier is not configured, the default model is used for that tier.
   */
  tiers?: {
    /** Simple messages: greetings, yes/no, short factual questions, small talk. */
    simple?: string;
    /** Medium complexity: summaries, explanations, short code, comparisons. */
    medium?: string;
    /** Complex tasks: code generation, deep analysis, multi-step reasoning, long writing. */
    complex?: string;
  };

  /**
   * Classification strategy.
   *
   * - "pattern" — Regex-only, zero cost, <1ms. Good for ~80% of messages.
   * - "hybrid" — Fast regex for high-confidence, falls back to classifierModel for ambiguous.
   *
   * Default: "pattern".
   */
  strategy?: "pattern" | "hybrid";

  /**
   * Model used for LLM-assisted classification in "hybrid" strategy.
   * Should be a fast, cheap model (e.g. "anthropic/claude-haiku-4-5").
   * Only used when pattern matching returns low confidence.
   *
   * Default: uses the "simple" tier model if set, otherwise skips LLM classification.
   */
  classifierModel?: string;

  /**
   * Timeout for the classifier LLM call in ms.
   * On timeout, falls back to the defaultTier model.
   * Default: 3000.
   */
  classifierTimeoutMs?: number;

  /**
   * Default tier when the classifier cannot determine complexity.
   * Default: "medium".
   */
  defaultTier?: "simple" | "medium" | "complex";

  /**
   * Override: always use the configured default model for these session keys
   * (glob patterns). Useful for pinning specific sessions to a fixed model.
   */
  excludeSessionKeys?: string[];

  /**
   * When true, log the routing decision to the subsystem logger.
   * Default: true.
   */
  logDecisions?: boolean;

  /**
   * Track manual /model switches after routing as implicit correction signals.
   * Logged to the subsystem logger for analysis.
   * Default: true.
   */
  trackCorrections?: boolean;
};
