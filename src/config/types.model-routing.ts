export type ModelRoutingTier = "local-small" | "local-large" | "remote";

export type ModelRoutingMode = "off" | "tiered" | "hybrid";

export type ModelRoutingStakes = "low" | "medium" | "high";

export type ModelRoutingVerifiability = "low" | "medium" | "high";

export type ModelRoutingPolicy = {
  /**
   * - "off": do not apply routing; use the session/default model selection.
   * - "tiered": pick a single model tier for the whole run.
   * - "hybrid": run a planner model first (LLM-only), then an executor tier.
   */
  mode?: ModelRoutingMode;

  /** Convenience for tiered mode; also used as fallback when executorTier is unset. */
  tier?: ModelRoutingTier;

  /** Executor tier for hybrid mode. */
  executorTier?: ModelRoutingTier;

  /** Optional explicit model override for the planner (provider/model or alias). */
  plannerModel?: string;

  /** Optional explicit model override for the executor (provider/model or alias). */
  executorModel?: string;

  /**
   * How risky this run is. Used as a hint when choosing between local/remote
   * when the policy is ambiguous.
   */
  stakes?: ModelRoutingStakes;

  /**
   * Whether outputs are expected to be machine-checkable (schema/tests/lint),
   * and therefore safe to run on smaller local tiers.
   */
  verifiability?: ModelRoutingVerifiability;

  /** Maximum number of tool calls the executor should attempt (prompt-level). */
  maxToolCalls?: number;

  /** Hint for whether write-capable tools are expected/allowed (prompt-level). */
  allowWriteTools?: boolean;

  /**
   * When true (default), do not override an explicit model already persisted on the session.
   * This avoids "flapping" in multi-turn conversations.
   */
  respectSessionOverride?: boolean;
};

export type ModelRoutingConfig = {
  enabled?: boolean;

  /**
   * Named tier models (provider/model or alias).
   * These are used when policies pick a tier without specifying an explicit model.
   */
  models?: {
    localSmall?: string;
    localLarge?: string;
    remote?: string;
    planner?: string;
  };

  /** Base policy applied to all intents unless overridden. */
  defaultPolicy?: ModelRoutingPolicy;

  /**
   * Per-intent overrides. Examples:
   * - "cli.agent"
   * - "heartbeat"
   * - "hooks.gmail"
   */
  intents?: Record<string, ModelRoutingPolicy>;
};
