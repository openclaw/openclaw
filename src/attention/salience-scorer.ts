/**
 * @module salience-scorer
 * Core salience scoring function for the Aether Attention Architecture.
 *
 * Scores an incoming event on 6 dimensions using lightweight deterministic
 * heuristics — zero LLM calls, zero API calls.
 *
 * Scoring formula:
 *   raw_score = Σ(factor_i × base_weight_i × mode_modifier_i) / weight_sum
 *   salience  = sigmoid(6 × (raw_score − 0.5))
 *
 * The steeper sigmoid (k=6) spreads outputs across the practical [0, 1]
 * range so that suppression_threshold values (0.40–0.95) in the config
 * are meaningful. Raw raw_score = 0.5 → salience = 0.50.
 *
 * All numbers are initial hypotheses; see attention-architecture-spec-v2.md
 * §10.3 for calibration guidance.
 */

import type { AttentionConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The six scoring dimensions tracked individually. */
export type SalienceDimension =
  | "urgency"
  | "strategic_importance"
  | "personal_relevance"
  | "time_sensitivity"
  | "reversibility_cost"
  | "novelty";

/** Result of scoring a single event. */
export interface SalienceScore {
  /**
   * Final salience score in [0, 1].
   * Derived from the weighted, mode-adjusted, sigmoid-transformed raw score.
   */
  total: number;

  /** Individual 0–1 scores for each of the 6 dimensions. */
  factors: Record<SalienceDimension, number>;

  /** The mode whose weight_modifiers were applied. */
  mode_applied: string;

  /**
   * True when the total score fell below the current mode's
   * suppression_threshold. Suppressed events should enter the queue,
   * not be routed to the user.
   */
  suppressed: boolean;
}

// ---------------------------------------------------------------------------
// Heuristic keyword tables
// ---------------------------------------------------------------------------

/** High-urgency signal words (case-insensitive). */
const URGENCY_KEYWORDS = [
  "deadline",
  "urgent",
  "urgently",
  "asap",
  "pdufa",
  "stop-loss",
  "stop loss",
  "emergency",
  "alert",
  "critical",
  "immediately",
  "right now",
  "expires",
  "expiring",
  "time-sensitive",
];

/** Time-sensitivity signal phrases (case-insensitive). */
const TIME_SENSITIVITY_KEYWORDS = [
  "today",
  "tonight",
  "now",
  "immediately",
  "before ",
  "by today",
  "by end",
  "eod",
  "eow",
  "this morning",
  "this afternoon",
  "open", // "market open"
  "close", // "market close"
  "in the next",
  "within hours",
  "within minutes",
  "cutoff",
];

/** Reversibility-cost / high-stakes domain words. */
const REVERSIBILITY_KEYWORDS = [
  "medical",
  "osce",
  "pdufa",
  "fda",
  "irreversible",
  "deadline",
  "trade",
  "position",
  "catalyst",
  "approval",
  "rejection",
  "surgery",
  "patient",
  "diagnosis",
  "prescription",
  "exam",
  "clinical",
  "ward",
];

/**
 * Strategic importance score by channel name.
 * Channels not in this map fall back to DEFAULT_CHANNEL_IMPORTANCE.
 */
const CHANNEL_IMPORTANCE: Record<string, number> = {
  "trading-signals": 0.9,
  "options-trader": 0.85,
  "osce-practice": 0.8,
  "tutoring-2700": 0.75,
  "research-radar": 0.7,
  experiments: 0.65,
  "build-log": 0.65,
  general: 0.5,
  outreach: 0.45,
  captures: 0.45,
  "system-alerts": 0.9,
};
const DEFAULT_CHANNEL_IMPORTANCE = 0.3;

/** Personal relevance: name / pronoun triggers that signal direct addressal. */
const PERSONAL_KEYWORDS = ["nir", " you ", " your ", " you'", "yours"];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Sigmoid function with configurable steepness.
 * sigmoid(x) = 1 / (1 + exp(−k·x))
 * At k=6: input ±0.5 → output ≈ [0.05, 0.95]; maps [0,1] to a full S-curve.
 */
function sigmoid(x: number, k = 6): number {
  return 1 / (1 + Math.exp(-k * x));
}

/**
 * Score urgency 0–1 based on keyword presence.
 * High-urgency keywords → 0.90; partial match (single keyword) → 0.70;
 * no match → 0.10 (everything has some baseline urgency).
 */
function scoreUrgency(content: string): number {
  const lower = content.toLowerCase();
  const matches = URGENCY_KEYWORDS.filter((kw) => lower.includes(kw)).length;
  if (matches === 0) {
    return 0.1;
  }
  if (matches === 1) {
    return 0.7;
  }
  return 0.9;
}

/**
 * Score strategic importance 0–1 based on channel.
 * Falls back to DEFAULT_CHANNEL_IMPORTANCE for unknown channels.
 */
function scoreStrategicImportance(channel: string): number {
  return CHANNEL_IMPORTANCE[channel] ?? DEFAULT_CHANNEL_IMPORTANCE;
}

/**
 * Score personal relevance 0–1.
 * Detects name mentions ("Nir") and direct pronouns ("you", "your").
 */
function scorePersonalRelevance(content: string): number {
  const lower = ` ${content.toLowerCase()} `;
  const matched = PERSONAL_KEYWORDS.some((kw) => lower.includes(kw));
  return matched ? 0.8 : 0.3;
}

/**
 * Score time sensitivity 0–1 from temporal keywords.
 * Multiple matches → 0.90; single match → 0.70; none → 0.15.
 */
function scoreTimeSensitivity(content: string): number {
  const lower = content.toLowerCase();
  const matches = TIME_SENSITIVITY_KEYWORDS.filter((kw) => lower.includes(kw)).length;
  if (matches === 0) {
    return 0.15;
  }
  if (matches === 1) {
    return 0.7;
  }
  return 0.9;
}

/**
 * Score reversibility cost 0–1 based on high-stakes domain terms.
 * Multiple matches → 0.80; single → 0.60; none → 0.15.
 */
function scoreReversibilityCost(content: string): number {
  const lower = content.toLowerCase();
  const matches = REVERSIBILITY_KEYWORDS.filter((kw) => lower.includes(kw)).length;
  if (matches === 0) {
    return 0.15;
  }
  if (matches === 1) {
    return 0.6;
  }
  return 0.8;
}

/**
 * Score novelty 0–1 by comparing content to the last N recent items.
 * Uses word-level Jaccard similarity. If the most similar recent item
 * exceeds the SIMILARITY_THRESHOLD, novelty is low (content is familiar).
 *
 * Schmidhuber compression-progress principle: partially novel content scores
 * higher than both pure noise and fully-predictable repeats.
 *
 * @param content - The incoming event content.
 * @param recentItems - Up to 20 recent content strings to compare against.
 */
function scoreNovelty(content: string, recentItems: string[]): number {
  if (recentItems.length === 0) {
    return 0.9;
  } // Nothing to compare → very novel

  const SIMILARITY_THRESHOLD = 0.35;
  const contentWords = new Set(
    content
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3),
  );

  if (contentWords.size === 0) {
    return 0.5;
  } // Empty/trivial content

  let maxSimilarity = 0;
  const limit = Math.min(20, recentItems.length);

  for (let i = 0; i < limit; i++) {
    const recentWords = new Set(
      (recentItems[i] ?? "")
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 3),
    );
    if (recentWords.size === 0) {
      continue;
    }

    // Jaccard similarity: |A ∩ B| / |A ∪ B|
    let intersection = 0;
    for (const w of contentWords) {
      if (recentWords.has(w)) {
        intersection++;
      }
    }
    const union = contentWords.size + recentWords.size - intersection;
    const similarity = union > 0 ? intersection / union : 0;
    if (similarity > maxSimilarity) {
      maxSimilarity = similarity;
    }
  }

  if (maxSimilarity > SIMILARITY_THRESHOLD) {
    // Familiar — linear falloff from 0.5 → 0.1 as similarity approaches 1.0
    return Math.max(0.1, 0.5 - maxSimilarity * 0.4);
  }

  // Novel — linear rise from 0.5 → 0.9 as similarity approaches 0
  return Math.min(0.9, 0.9 - maxSimilarity * 1.1);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Score an incoming event for salience given the current operating mode.
 *
 * The scoring is entirely deterministic — no LLM calls, no I/O.
 * All six dimension heuristics run in O(content_length × keywords).
 *
 * Formula:
 *   raw_score  = Σ(factor_i × base_weight_i × mode_modifier_i) / weight_sum
 *   salience   = sigmoid(6 × (raw_score − 0.5))
 *
 * Channel amplification/suppression (from modes config) is applied after
 * the sigmoid, clamping the result to [0, 1].
 *
 * @param content - Full text of the incoming event.
 * @param channel - Source channel identifier (e.g. "trading-signals").
 * @param currentMode - The currently active mode (e.g. "deep_work").
 * @param recentItems - Up to 20 recent content strings for novelty comparison.
 * @param config - The loaded AttentionConfig.
 * @returns SalienceScore with total, per-factor breakdown, and suppression flag.
 */
export function scoreEvent(
  content: string,
  channel: string,
  currentMode: string,
  recentItems: string[],
  config: AttentionConfig,
): SalienceScore {
  // ── 1. Score each factor (0–1) ────────────────────────────────────────────
  const factors: Record<SalienceDimension, number> = {
    urgency: scoreUrgency(content),
    strategic_importance: scoreStrategicImportance(channel),
    personal_relevance: scorePersonalRelevance(content),
    time_sensitivity: scoreTimeSensitivity(content),
    reversibility_cost: scoreReversibilityCost(content),
    novelty: scoreNovelty(content, recentItems),
  };

  // ── 2. Resolve mode config & modifiers ────────────────────────────────────
  const modeConfig = config.modes[currentMode] ?? config.modes["uncertain"];
  const modifiers = modeConfig?.weight_modifiers ?? {
    urgency: 1,
    strategic_importance: 1,
    personal_relevance: 1,
    time_sensitivity: 1,
    reversibility_cost: 1,
    novelty: 1,
  };
  const baseWeights = config.base_weights;

  const dimensions: SalienceDimension[] = [
    "urgency",
    "strategic_importance",
    "personal_relevance",
    "time_sensitivity",
    "reversibility_cost",
    "novelty",
  ];

  // ── 3. Compute weighted sum and normalize ─────────────────────────────────
  let weightedSum = 0;
  let weightSum = 0;

  for (const dim of dimensions) {
    const adjustedWeight = baseWeights[dim] * modifiers[dim];
    weightedSum += factors[dim] * adjustedWeight;
    weightSum += adjustedWeight;
  }

  const rawScore = weightSum > 0 ? weightedSum / weightSum : 0;

  // ── 4. Apply sigmoid (k=6) centred at 0.5 ────────────────────────────────
  let total = sigmoid(rawScore - 0.5);

  // ── 5. Channel amplification / suppression ────────────────────────────────
  if (modeConfig) {
    if (
      modeConfig.channels_suppressed.includes("all") ||
      modeConfig.channels_suppressed.includes(channel)
    ) {
      total *= 0.5;
    } else if (modeConfig.channels_amplified.includes(channel)) {
      total = Math.min(1.0, total * 1.2);
    }
  }

  total = Math.max(0, Math.min(1, total));

  // ── 6. Determine suppression ──────────────────────────────────────────────
  const suppressionThreshold = modeConfig?.suppression_threshold ?? 0.5;
  const suppressed = total < suppressionThreshold;

  return {
    total,
    factors,
    mode_applied: modeConfig ? currentMode : "uncertain",
    suppressed,
  };
}
