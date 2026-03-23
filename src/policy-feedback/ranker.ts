/**
 * Candidate ranking for the policy feedback subsystem.
 *
 * Scores candidate actions using a composite heuristic based on historical
 * effectiveness, intervention fatigue, time-of-day patterns, recency, and
 * risk adjustment. Each factor is independently configurable via RankingWeights.
 */

import type { AggregateComputer } from "./aggregates.js";
import { featureFlagsForMode } from "./config.js";
import type { ActionLedger } from "./ledger.js";
import type {
  AggregateStats,
  CandidateAction,
  GetPolicyHintsInput,
  PolicyContext,
  PolicyFeedbackConfig,
  PolicyHints,
  RankCandidatesInput,
  ScoredCandidate,
} from "./types.js";

// ---------------------------------------------------------------------------
// Ranking Weights
// ---------------------------------------------------------------------------

export type RankingWeights = {
  /** Max bonus/penalty from historical effectiveness (default 20) */
  historicalEffectiveness: number;
  /** Penalty per recent action in the fatigue window (default 5) */
  fatiguePenaltyPerAction: number;
  /** Maximum total fatigue penalty (default 25) */
  maxFatiguePenalty: number;
  /** Max bonus/penalty from time-of-day effectiveness (default 10) */
  timeOfDayBonus: number;
  /** Penalty per same-action-type occurrence in recency window (default 3) */
  recencyPenaltyPerAction: number;
  /** Maximum total recency penalty (default 15) */
  maxRecencyPenalty: number;
  /** Penalty when risk is high and confidence is low (default 10) */
  riskPenalty: number;
  /** Score threshold below which candidates are suppressed (default 30) */
  suppressionThreshold: number;
};

export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  historicalEffectiveness: 20,
  fatiguePenaltyPerAction: 5,
  maxFatiguePenalty: 25,
  timeOfDayBonus: 10,
  recencyPenaltyPerAction: 3,
  maxRecencyPenalty: 15,
  riskPenalty: 10,
  suppressionThreshold: 30,
};

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** Base score for all candidates on the 0-100 internal scale */
const BASE_SCORE = 50;

/** Fatigue window: 6 hours in ms */
const FATIGUE_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Recency window: 24 hours in ms */
const RECENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// CandidateRanker
// ---------------------------------------------------------------------------

export class CandidateRanker {
  private readonly aggregates: AggregateComputer;
  private readonly config: PolicyFeedbackConfig;
  private readonly ledger: ActionLedger;
  private readonly weights: RankingWeights;

  constructor(
    aggregates: AggregateComputer,
    config: PolicyFeedbackConfig,
    ledger: ActionLedger,
    weights?: Partial<RankingWeights>,
  ) {
    this.aggregates = aggregates;
    this.config = config;
    this.ledger = ledger;
    this.weights = { ...DEFAULT_RANKING_WEIGHTS, ...weights };
  }

  /**
   * Rank candidate actions by composite score.
   *
   * When the `enableRanking` feature flag is disabled, returns all candidates
   * with a score of 0.5 (50 on internal scale) and no suppression.
   *
   * In advisory mode, scoring is computed normally but each candidate gets
   * a "mode: advisory" note appended to reasons.
   */
  async rankCandidates(input: RankCandidatesInput): Promise<ScoredCandidate[]> {
    const flags = featureFlagsForMode(this.config.mode);

    // Feature flag disabled: return unsorted with neutral score
    if (!flags.enableRanking) {
      return input.candidates.map((candidate) => ({
        candidate,
        score: 0.5,
        reasons: ["Ranking disabled — returning base score"],
        suppress: false,
      }));
    }

    const [aggregatesList, recentActions] = await Promise.all([
      this.aggregates.getAggregates(),
      this.ledger.getRecentActions(input.agentId, 100),
    ]);

    const stats = aggregatesList[0];
    const now = Date.now();

    const scored = input.candidates.map((candidate) =>
      this.scoreCandidate(candidate, input.context, stats, recentActions, now),
    );

    // Sort descending by score
    const sorted = scored.toSorted((a, b) => b.score - a.score);

    // Advisory mode note
    if (this.config.mode === "advisory") {
      for (const s of sorted) {
        s.reasons.push("mode: advisory");
      }
    }

    return sorted;
  }

  /**
   * Get policy hints for the current context.
   *
   * Returns actionable guidance: whether to act, confidence level,
   * preferred action, and debug information.
   */
  async getPolicyHints(input: GetPolicyHintsInput): Promise<PolicyHints> {
    const context: PolicyContext = input.context ?? {
      channelId: input.channelId,
    };

    // Build a synthetic candidate to evaluate the general "should act" question
    const syntheticCandidate: CandidateAction = {
      id: "__policy_hint__",
      actionType: "agent_reply",
      description: "Synthetic candidate for policy hint evaluation",
    };

    const ranked = await this.rankCandidates({
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      candidates: [syntheticCandidate],
      context,
    });

    const topCandidate = ranked[0];
    const allSuppressed = ranked.every((c) => c.suppress);

    // Determine fatigue level from context
    const fatigueLevel = Math.min(1, (context.recentActionCount ?? 0) / 10);

    // Determine data quality / confidence
    const aggregatesList = await this.aggregates.getAggregates();
    const stats = aggregatesList[0];
    const confidence = computeDataConfidence(stats);

    // Determine recommendation
    let recommendation: "proceed" | "caution" | "suppress";
    if (allSuppressed) {
      recommendation = "suppress";
    } else if (topCandidate && topCandidate.score < 0.5) {
      recommendation = "caution";
    } else {
      recommendation = "proceed";
    }

    const reasons: string[] = [];
    if (allSuppressed) {
      reasons.push("All candidate actions scored below suppression threshold");
    }
    if (fatigueLevel > 0.5) {
      reasons.push(`High fatigue level: ${fatigueLevel.toFixed(2)}`);
    }
    if (confidence < 0.3) {
      reasons.push("Low data confidence — limited historical data");
    }

    const timingHint =
      context.hourOfDay !== undefined ? buildTimingHint(context.hourOfDay, stats) : undefined;

    const toneHints: string[] = [];
    if (fatigueLevel > 0.7) {
      toneHints.push("Consider a lighter, less intrusive tone");
    }

    return {
      recommendation,
      reasons,
      toneHints: toneHints.length > 0 ? toneHints : undefined,
      timingHint,
      fatigueLevel,
      activeConstraints: allSuppressed
        ? ranked.filter((c) => c.suppress).map((c) => c.suppressionRule ?? "score_threshold")
        : [],
      mode: this.config.mode,
    };
  }

  // -------------------------------------------------------------------------
  // Private scoring
  // -------------------------------------------------------------------------

  private scoreCandidate(
    candidate: CandidateAction,
    context: PolicyContext,
    stats: AggregateStats,
    recentActions: { timestamp: string; actionType: string }[],
    now: number,
  ): ScoredCandidate {
    const reasons: string[] = [];
    let score = BASE_SCORE;
    reasons.push(`Base score: ${BASE_SCORE}`);

    // (a) Historical effectiveness: +/- up to historicalEffectiveness points
    const effectivenessAdj = this.computeHistoricalEffectiveness(candidate.actionType, stats);
    score += effectivenessAdj;
    if (effectivenessAdj !== 0) {
      reasons.push(
        `Historical effectiveness: ${effectivenessAdj > 0 ? "+" : ""}${effectivenessAdj.toFixed(1)}`,
      );
    }

    // (b) Intervention fatigue: -fatiguePenaltyPerAction per recent action (6h window)
    const fatigueAdj = this.computeFatiguePenalty(context, recentActions, now);
    score += fatigueAdj;
    if (fatigueAdj !== 0) {
      reasons.push(`Intervention fatigue: ${fatigueAdj.toFixed(1)}`);
    }

    // (c) Time-of-day: +/- timeOfDayBonus based on hour effectiveness
    const todAdj = this.computeTimeOfDayAdjustment(context, stats);
    score += todAdj;
    if (todAdj !== 0) {
      reasons.push(`Time-of-day adjustment: ${todAdj > 0 ? "+" : ""}${todAdj.toFixed(1)}`);
    }

    // (d) Recency penalty: -recencyPenaltyPerAction per same type in 24h
    const recencyAdj = this.computeRecencyPenalty(candidate.actionType, recentActions, now);
    score += recencyAdj;
    if (recencyAdj !== 0) {
      reasons.push(`Recency penalty: ${recencyAdj.toFixed(1)}`);
    }

    // (e) Risk adjustment: -riskPenalty when risk high + confidence low
    const riskAdj = this.computeRiskAdjustment(stats);
    score += riskAdj;
    if (riskAdj !== 0) {
      reasons.push(`Risk adjustment: ${riskAdj.toFixed(1)}`);
    }

    // Clamp to 0-100
    score = Math.max(0, Math.min(100, score));

    // Normalize to 0-1 for the ScoredCandidate interface
    const normalizedScore = score / 100;

    // Suppression check
    const suppress = score < this.weights.suppressionThreshold;

    return {
      candidate,
      score: normalizedScore,
      reasons,
      suppress,
      suppressionRule: suppress ? "score_below_threshold" : undefined,
    };
  }

  /**
   * Historical effectiveness: maps the action type's reply rate to a
   * +/- adjustment. 0.5 reply rate = neutral, 1.0 = full bonus, 0.0 = full penalty.
   */
  private computeHistoricalEffectiveness(actionType: string, stats: AggregateStats): number {
    const typeStats = stats.byActionType[actionType as keyof typeof stats.byActionType];
    if (!typeStats || typeStats.count === 0) {
      return 0;
    }

    // Map replyRate (0-1) to [-weight, +weight]
    // replyRate 0.5 => 0 adjustment, 1.0 => +weight, 0.0 => -weight
    const deviation = typeStats.replyRate - 0.5;
    return deviation * 2 * this.weights.historicalEffectiveness;
  }

  /**
   * Intervention fatigue: penalizes based on the number of recent actions
   * within the 6-hour fatigue window.
   */
  private computeFatiguePenalty(
    context: PolicyContext,
    recentActions: { timestamp: string }[],
    now: number,
  ): number {
    // Use context.recentActionCount if available, otherwise count from ledger
    let recentCount: number;
    if (context.recentActionCount !== undefined) {
      recentCount = context.recentActionCount;
    } else {
      const cutoff = now - FATIGUE_WINDOW_MS;
      recentCount = recentActions.filter((a) => new Date(a.timestamp).getTime() >= cutoff).length;
    }

    const penalty = Math.min(
      recentCount * this.weights.fatiguePenaltyPerAction,
      this.weights.maxFatiguePenalty,
    );
    return -penalty;
  }

  /**
   * Time-of-day adjustment: bonus/penalty based on how effective the current
   * hour has been historically. Average reply rate => neutral; above => bonus.
   */
  private computeTimeOfDayAdjustment(context: PolicyContext, stats: AggregateStats): number {
    if (context.hourOfDay === undefined) {
      return 0;
    }

    const hourStats = stats.byHourOfDay[context.hourOfDay];
    if (!hourStats || hourStats.count === 0) {
      return 0;
    }

    // Compute average reply rate across all hours (filter out undefined from Partial<Record>)
    const hours = Object.values(stats.byHourOfDay).filter(
      (h): h is NonNullable<typeof h> => h != null && h.count > 0,
    );
    if (hours.length === 0) {
      return 0;
    }
    const avgReplyRate = hours.reduce((sum, h) => sum + h.replyRate, 0) / hours.length;

    // Map deviation from average to +/- timeOfDayBonus
    const deviation = hourStats.replyRate - avgReplyRate;
    // Clamp to [-1, 1] range before scaling
    const clamped = Math.max(-1, Math.min(1, deviation * 2));
    return clamped * this.weights.timeOfDayBonus;
  }

  /**
   * Recency penalty: penalizes repeated use of the same action type
   * within the 24-hour recency window.
   */
  private computeRecencyPenalty(
    actionType: string,
    recentActions: { timestamp: string; actionType: string }[],
    now: number,
  ): number {
    const cutoff = now - RECENCY_WINDOW_MS;
    const sameTypeCount = recentActions.filter(
      (a) => a.actionType === actionType && new Date(a.timestamp).getTime() >= cutoff,
    ).length;

    const penalty = Math.min(
      sameTypeCount * this.weights.recencyPenaltyPerAction,
      this.weights.maxRecencyPenalty,
    );
    return -penalty;
  }

  /**
   * Risk adjustment: applies a penalty when there is high risk (low overall
   * effectiveness) combined with low confidence (limited data).
   */
  private computeRiskAdjustment(stats: AggregateStats): number {
    // "High risk" = low overall reply rate; "low confidence" = limited data
    const totalActions = stats.totalActions;
    if (totalActions === 0) {
      return 0;
    }

    // Compute overall reply rate
    const types = Object.values(stats.byActionType);
    if (types.length === 0) {
      return 0;
    }

    const totalReplies = types.reduce((sum, t) => sum + (t ? t.replyRate * t.count : 0), 0);
    const totalCount = types.reduce((sum, t) => sum + (t?.count ?? 0), 0);
    const overallReplyRate = totalCount > 0 ? totalReplies / totalCount : 0;

    const confidence = computeDataConfidence(stats);

    // Apply penalty when reply rate is low AND confidence is low
    if (overallReplyRate < 0.3 && confidence < 0.5) {
      return -this.weights.riskPenalty;
    }

    return 0;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute a 0-1 confidence score based on data quantity.
 * More total actions = higher confidence, saturating around 100 actions.
 */
function computeDataConfidence(stats: AggregateStats): number {
  // Simple logistic-like curve: 0 actions => 0, 50 actions => ~0.5, 100+ => ~0.9
  const actions = stats.totalActions;
  if (actions === 0) {
    return 0;
  }
  return Math.min(1, actions / 100);
}

/**
 * Build a human-readable timing hint from hour-of-day stats.
 */
function buildTimingHint(hourOfDay: number, stats: AggregateStats): string | undefined {
  const hourStats = stats.byHourOfDay[hourOfDay];
  if (!hourStats || hourStats.count === 0) {
    return `No historical data for hour ${hourOfDay}`;
  }

  if (hourStats.replyRate > 0.6) {
    return `Hour ${hourOfDay} has above-average response rate (${(hourStats.replyRate * 100).toFixed(0)}%)`;
  }
  if (hourStats.replyRate < 0.3) {
    return `Hour ${hourOfDay} has below-average response rate (${(hourStats.replyRate * 100).toFixed(0)}%) — consider deferring`;
  }
  return undefined;
}
