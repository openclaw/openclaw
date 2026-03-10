/**
 * @module types
 * Shared TypeScript interfaces for the Aether Attention Architecture.
 *
 * Field names match ~/aether/conductor/attention-config.json exactly.
 * Do not rename fields — they are used as JSON keys at runtime.
 */

// ---------------------------------------------------------------------------
// Weight & modifier interfaces
// ---------------------------------------------------------------------------

/**
 * Base scoring weights for the six salience dimensions.
 * Default values: urgency 0.22, strategic_importance 0.22,
 * personal_relevance 0.14, time_sensitivity 0.18,
 * reversibility_cost 0.14, novelty 0.10.
 */
export interface BaseWeights {
  urgency: number;
  strategic_importance: number;
  personal_relevance: number;
  time_sensitivity: number;
  reversibility_cost: number;
  novelty: number;
}

/**
 * Per-mode weight modifiers — multiplicative scalars applied to base weights.
 * Values >1 amplify the dimension; values <1 suppress it.
 * Same shape as BaseWeights for easy spread/merge.
 */
export type WeightModifiers = BaseWeights;

// ---------------------------------------------------------------------------
// Mode configuration
// ---------------------------------------------------------------------------

/**
 * Hysteresis parameters controlling mode transition stability.
 * Prevents rapid oscillation between modes (Schmitt-trigger pattern).
 */
export interface HysteresisConfig {
  /**
   * Minimum detection confidence required to *enter* this mode.
   * Higher = harder to enter.
   */
  entry_threshold: number;

  /**
   * Signal must fall *below* this value before the mode can be exited.
   * Must be strictly less than entry_threshold to create the dead-band.
   */
  exit_threshold: number;

  /**
   * Minimum minutes that must elapse in the current mode before
   * any exit is permitted. Guards against premature transitions.
   */
  min_dwell_minutes: number;
}

/**
 * Complete definition for a single operating mode.
 * Each mode reconfigures how incoming events are weighted and routed.
 */
export interface ModeConfig {
  /** Human-readable description of when this mode is active. */
  description: string;

  /**
   * Multipliers applied to each base weight dimension.
   * Derived from neuromodulatory state analogies — trading mode boosts
   * urgency/time_sensitivity; deep_work suppresses personal_relevance/novelty.
   */
  weight_modifiers: WeightModifiers;

  /**
   * Minimum mode-adjusted salience score an event must reach to be routed.
   * Events below this threshold enter the suppression queue.
   * Ranges from 0.40 (admin — permissive) to 0.95 (sleep — near-silent).
   */
  suppression_threshold: number;

  /** Hysteresis configuration for stable mode transitions. */
  hysteresis: HysteresisConfig;

  /**
   * Channels whose events receive a 20% score amplification in this mode.
   * E.g. trading-signals is amplified in trading mode.
   */
  channels_amplified: string[];

  /**
   * Channels whose events receive a 50% score suppression in this mode.
   * The string "all" means every channel is suppressed.
   */
  channels_suppressed: string[];
}

// ---------------------------------------------------------------------------
// Top-level config
// ---------------------------------------------------------------------------

/**
 * Mapping of time-range strings (format "HH:MM-HH:MM") to mode names.
 * Used as a lowest-priority fallback in mode detection.
 * @example { "09:00-14:30": "deep_work", "22:00-00:00": "sleep" }
 */
export type TimeDefaults = Record<string, string>;

/**
 * Mapping of mode names to arrays of trigger phrases.
 * When any phrase appears in a recent message, the mode is set immediately,
 * bypassing hysteresis.
 * @example { "trading": ["trading time", "market time", "markets open"] }
 */
export type ExplicitCommandKeywords = Record<string, string[]>;

/**
 * Mapping of mode names to calendar event title keywords.
 * When an active calendar event's title contains a keyword, the matching
 * mode is signalled (subject to hysteresis).
 * @example { "study_osce": ["OSCE", "Clinical", "Ward"] }
 */
export type CalendarKeywordMap = Record<string, string[]>;

/**
 * The full attention configuration.
 * Loaded from ~/aether/conductor/attention-config.json at runtime.
 * All numeric thresholds and weights are initial hypotheses; see spec v2
 * for calibration guidance after 4–6 weeks of operation.
 */
export interface AttentionConfig {
  /** Schema version string (e.g. "1.0"). */
  version: string;

  /** ISO date of last manual calibration (e.g. "2026-03-02"). */
  last_calibrated: string;

  /** Free-text notes about calibration basis or outstanding review items. */
  calibration_notes: string;

  /**
   * Base scoring weights summing to 1.0.
   * These are multiplied by per-mode weight_modifiers before scoring.
   */
  base_weights: BaseWeights;

  /**
   * Per-mode configurations keyed by mode name.
   * Known modes: deep_work, trading, study_osce, social, admin, recovery,
   * sleep, uncertain.
   */
  modes: Record<string, ModeConfig>;

  /**
   * Time-of-day default mode mapping.
   * Lowest-priority fallback in the mode detection cascade.
   */
  time_defaults: TimeDefaults;

  /**
   * Explicit command phrases that immediately override mode (bypass hysteresis).
   */
  explicit_command_keywords: ExplicitCommandKeywords;

  /**
   * Calendar event title keywords that signal a mode (subject to hysteresis).
   */
  calendar_keyword_map: CalendarKeywordMap;
}
