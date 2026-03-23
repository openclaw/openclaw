/**
 * Constraint enforcement for the policy feedback subsystem.
 *
 * The ConstraintLayer applies a sequence of constraint rules to scored
 * candidates, potentially suppressing or penalizing actions that violate
 * rate limits, cooldown periods, fatigue thresholds, or custom rules.
 */

import { featureFlagsForMode } from "./config.js";
import type {
  AggregateStats,
  ConstraintCondition,
  ConstraintRule,
  PolicyContext,
  PolicyFeedbackConfig,
  ScoredCandidate,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default max nudges per 24-hour window */
const DEFAULT_MAX_NUDGES_PER_DAY = 20;

/** Default cooldown period in ms (1 hour) */
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;

/** Default consecutive-ignore threshold before suppression */
const DEFAULT_REPEATED_IGNORES_THRESHOLD = 3;

/** Default uncertainty threshold (below this confidence, prefer no-op) */
const DEFAULT_UNCERTAINTY_THRESHOLD = 0.2;

// ---------------------------------------------------------------------------
// Built-in constraint functions (pure, independently testable)
// ---------------------------------------------------------------------------

/**
 * Suppress all candidates if the recent action count exceeds the daily max.
 */
export function applyMaxNudgesPerDay(
  candidates: ScoredCandidate[],
  context: PolicyContext,
  maxNudges: number,
): ScoredCandidate[] {
  const recentCount = context.recentActionCount ?? 0;
  if (recentCount <= maxNudges) {
    return candidates;
  }

  return candidates.map((c) => ({
    ...c,
    suppress: true,
    suppressionRule: c.suppressionRule ?? "max_nudges_per_day",
    reasons: [
      ...c.reasons,
      `Suppressed: recent action count (${recentCount}) exceeds daily max (${maxNudges})`,
    ],
  }));
}

/**
 * Suppress candidates whose action type has been ignored N times
 * consecutively (from context.consecutiveIgnores).
 */
export function applyRepeatedIgnores(
  candidates: ScoredCandidate[],
  context: PolicyContext,
  threshold: number,
): ScoredCandidate[] {
  const ignores = context.consecutiveIgnores ?? 0;
  if (ignores < threshold) {
    return candidates;
  }

  return candidates.map((c) => {
    // Only suppress action types that generate user-facing output
    const isUserFacing =
      c.candidate.actionType === "agent_reply" ||
      c.candidate.actionType === "heartbeat_run" ||
      c.candidate.actionType === "cron_run";

    if (!isUserFacing) {
      return c;
    }

    return {
      ...c,
      suppress: true,
      suppressionRule: c.suppressionRule ?? "repeated_ignores",
      reasons: [
        ...c.reasons,
        `Suppressed: ${ignores} consecutive ignores (threshold: ${threshold})`,
      ],
    };
  });
}

/**
 * Suppress candidates if the time since last action is within the cooldown
 * window.
 */
export function applyCooldownPeriod(
  candidates: ScoredCandidate[],
  context: PolicyContext,
  cooldownMs: number,
): ScoredCandidate[] {
  const elapsed = context.timeSinceLastActionMs;
  if (elapsed === undefined || elapsed >= cooldownMs) {
    return candidates;
  }

  return candidates.map((c) => ({
    ...c,
    suppress: true,
    suppressionRule: c.suppressionRule ?? "cooldown_period",
    reasons: [...c.reasons, `Suppressed: cooldown period (${elapsed}ms < ${cooldownMs}ms)`],
  }));
}

/**
 * If overall confidence is below the threshold, prefer no-op by
 * suppressing non-no-op candidates and boosting no-op candidates.
 */
export function applyUncertaintyThreshold(
  candidates: ScoredCandidate[],
  overallConfidence: number,
  threshold: number,
): ScoredCandidate[] {
  if (overallConfidence >= threshold) {
    return candidates;
  }

  return candidates.map((c) => {
    if (c.candidate.actionType === "no_op") {
      return {
        ...c,
        reasons: [
          ...c.reasons,
          `Boosted: low confidence (${overallConfidence.toFixed(2)}) favors no-op`,
        ],
      };
    }

    return {
      ...c,
      suppress: true,
      suppressionRule: c.suppressionRule ?? "uncertainty_threshold",
      reasons: [
        ...c.reasons,
        `Suppressed: confidence (${overallConfidence.toFixed(2)}) below threshold (${threshold})`,
      ],
    };
  });
}

/**
 * Apply a single custom ConstraintRule to candidates.
 */
export function applyCustomConstraint(
  candidates: ScoredCandidate[],
  rule: ConstraintRule,
  context: PolicyContext,
  stats?: AggregateStats,
): ScoredCandidate[] {
  const triggered = evaluateCondition(rule.condition, context, stats);
  if (!triggered) {
    return candidates;
  }

  return candidates.map((c) => {
    const reason = `Constraint "${rule.id}": ${rule.description}`;

    if (rule.action === "suppress") {
      return {
        ...c,
        suppress: true,
        suppressionRule: c.suppressionRule ?? rule.id,
        reasons: [...c.reasons, reason],
      };
    }

    // "warn" and "log" just add a reason but don't suppress
    return {
      ...c,
      reasons: [...c.reasons, reason],
    };
  });
}

/**
 * Evaluate whether a constraint condition is triggered given the context.
 * Pass aggregate stats to enable data-dependent conditions like low_effectiveness.
 */
export function evaluateCondition(
  condition: ConstraintCondition,
  context: PolicyContext,
  stats?: AggregateStats,
): boolean {
  switch (condition.type) {
    case "max_actions_per_period": {
      const count = context.recentActionCount ?? 0;
      return count > condition.maxCount;
    }
    case "consecutive_ignores": {
      const ignores = context.consecutiveIgnores ?? 0;
      return ignores >= condition.threshold;
    }
    case "time_of_day_block": {
      const hour = context.hourOfDay;
      if (hour === undefined) {
        return false;
      }
      if (condition.startHour <= condition.endHour) {
        return hour >= condition.startHour && hour < condition.endHour;
      }
      // Wraps around midnight (e.g., 22 to 6)
      return hour >= condition.startHour || hour < condition.endHour;
    }
    case "min_interval": {
      const elapsed = context.timeSinceLastActionMs;
      if (elapsed === undefined) {
        return false;
      }
      return elapsed < condition.minMs;
    }
    case "low_effectiveness": {
      if (!stats) {
        return false; // No aggregate data available — safe default
      }
      const typeStats = stats.byActionType[condition.actionType];
      if (!typeStats || typeStats.count === 0) {
        return false; // No data for this action type yet
      }
      return typeStats.replyRate < condition.threshold;
    }
  }
}

// ---------------------------------------------------------------------------
// ConstraintLayer
// ---------------------------------------------------------------------------

export class ConstraintLayer {
  private readonly config: PolicyFeedbackConfig;

  constructor(config: PolicyFeedbackConfig) {
    this.config = config;
  }

  /**
   * Apply all constraints (built-in + custom) to scored candidates.
   * Returns modified candidates with suppression flags and reasons.
   */
  applyConstraints(
    candidates: ScoredCandidate[],
    context: PolicyContext,
    options?: { overallConfidence?: number; stats?: AggregateStats },
  ): ScoredCandidate[] {
    const flags = featureFlagsForMode(this.config.mode);
    if (!flags.enableConstraints) {
      return candidates;
    }

    let result = candidates;

    // (a) Max nudges per day
    result = applyMaxNudgesPerDay(result, context, DEFAULT_MAX_NUDGES_PER_DAY);

    // (b) Repeated ignores
    result = applyRepeatedIgnores(result, context, DEFAULT_REPEATED_IGNORES_THRESHOLD);

    // (c) Cooldown period
    result = applyCooldownPeriod(result, context, DEFAULT_COOLDOWN_MS);

    // (d) Uncertainty threshold
    const confidence = options?.overallConfidence ?? 1;
    result = applyUncertaintyThreshold(result, confidence, DEFAULT_UNCERTAINTY_THRESHOLD);

    // (e) Custom constraint rules sorted by priority (lower = higher priority)
    const sortedRules = [...this.config.constraints].toSorted((a, b) => a.priority - b.priority);
    for (const rule of sortedRules) {
      result = applyCustomConstraint(result, rule, context, options?.stats);
    }

    return result;
  }

  /**
   * Returns true if the current context suggests silence/no-op is the
   * best choice — i.e., multiple built-in constraints would fire.
   */
  isNoOpPreferred(context: PolicyContext): boolean {
    const recentCount = context.recentActionCount ?? 0;
    const ignores = context.consecutiveIgnores ?? 0;
    const elapsed = context.timeSinceLastActionMs;

    // Count how many built-in constraints would trigger
    let triggered = 0;

    if (recentCount > DEFAULT_MAX_NUDGES_PER_DAY) {
      triggered++;
    }
    if (ignores >= DEFAULT_REPEATED_IGNORES_THRESHOLD) {
      triggered++;
    }
    if (elapsed !== undefined && elapsed < DEFAULT_COOLDOWN_MS) {
      triggered++;
    }

    // If 2+ constraints would fire, prefer no-op
    return triggered >= 2;
  }

  /**
   * Return descriptions of all currently configured constraint rules
   * (both built-in and custom).
   */
  getActiveConstraints(): string[] {
    const descriptions: string[] = [
      `max_nudges_per_day: suppress if recent actions exceed ${DEFAULT_MAX_NUDGES_PER_DAY} in 24h`,
      `repeated_ignores: suppress user-facing actions after ${DEFAULT_REPEATED_IGNORES_THRESHOLD} consecutive ignores`,
      `cooldown_period: suppress if last action within ${DEFAULT_COOLDOWN_MS}ms`,
      `uncertainty_threshold: prefer no-op if confidence below ${DEFAULT_UNCERTAINTY_THRESHOLD}`,
    ];

    for (const rule of this.config.constraints) {
      descriptions.push(`${rule.id}: ${rule.description}`);
    }

    return descriptions;
  }
}
