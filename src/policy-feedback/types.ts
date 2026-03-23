/**
 * Core type definitions for the policy feedback subsystem.
 *
 * These types define the data model, persistence records, configuration,
 * and engine interface for action logging, outcome tracking, aggregate
 * statistics, and policy hint generation.
 */

import type { RankingWeights } from "./ranker.js";

// ---------------------------------------------------------------------------
// Enums / Unions
// ---------------------------------------------------------------------------

export type PolicyMode = "off" | "passive" | "advisory" | "active";

export type ActionType =
  | "agent_reply"
  | "tool_call"
  | "cron_run"
  | "heartbeat_run"
  | "no_op"
  | "suppressed";

export type OutcomeType =
  | "delivery_success"
  | "delivery_failure"
  | "user_replied"
  | "user_silent"
  | "session_continued"
  | "session_ended"
  | "explicit_positive"
  | "explicit_negative";

// ---------------------------------------------------------------------------
// Persisted Records (JSONL lines)
// ---------------------------------------------------------------------------

export type ActionRecord = {
  /** Unique action ID */
  id: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Agent that took the action */
  agentId: string;
  /** Session key */
  sessionKey: string;
  /** Session UUID */
  sessionId?: string;
  /** Action classification */
  actionType: ActionType;
  /** Channel */
  channelId: string;
  /** Account ID */
  accountId?: string;
  /** Context summary at action time */
  contextSummary?: string;
  /** Tool or skill name */
  toolName?: string;
  /** Rationale */
  rationale?: string;
  /** Metadata */
  metadata?: Record<string, unknown>;
  /** Policy mode at the time of the action */
  policyMode: PolicyMode;
  /** Scoring snapshot, if ranked */
  scoring?: {
    score: number;
    reasons: string[];
    suppress: boolean;
    suppressionRule?: string;
  };
};

export type OutcomeRecord = {
  /** Unique outcome ID */
  id: string;
  /** ISO 8601 timestamp when the outcome was observed */
  timestamp: string;
  /** The action this outcome correlates with */
  actionId: string;
  /** Agent ID (for scoping) */
  agentId: string;
  /** Outcome type */
  outcomeType: OutcomeType;
  /** Numeric value (0-1 normalized) */
  value?: number;
  /** Observation horizon in ms */
  horizonMs?: number;
  /** Metadata */
  metadata?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Aggregate Stats (persisted as JSON)
// ---------------------------------------------------------------------------

export type ActionTypeStats = {
  count: number;
  outcomeCount: number;
  replyRate: number;
  avgResponseLatencyMs?: number;
  suppressionRate: number;
};

export type HourStats = {
  count: number;
  replyRate: number;
  avgResponseLatencyMs?: number;
};

export type AggregateStats = {
  /** When these aggregates were last computed */
  computedAt: string;
  /** Total actions logged */
  totalActions: number;
  /** Total outcomes logged */
  totalOutcomes: number;
  /** Per-action-type effectiveness */
  byActionType: Partial<Record<ActionType, ActionTypeStats>>;
  /** Per-hour-of-day effectiveness (0-23 keys) */
  byHourOfDay: Partial<Record<number, HourStats>>;
  /** Fatigue curve: effectiveness by consecutive-ignore count */
  byConsecutiveIgnores: Partial<Record<number, { count: number; replyRate: number }>>;
  /** Per-channel effectiveness */
  byChannel: Record<string, { count: number; replyRate: number; avgLatencyMs?: number }>;
};

// ---------------------------------------------------------------------------
// Constraint Rules
// ---------------------------------------------------------------------------

export type ConstraintCondition =
  | { type: "max_actions_per_period"; maxCount: number; periodMs: number }
  | { type: "consecutive_ignores"; threshold: number }
  | { type: "time_of_day_block"; startHour: number; endHour: number; timezone?: string }
  | { type: "min_interval"; minMs: number }
  | { type: "low_effectiveness"; threshold: number; actionType: ActionType };

export type ConstraintRule = {
  id: string;
  description: string;
  condition: ConstraintCondition;
  action: "suppress" | "warn" | "log";
  priority: number;
};

// ---------------------------------------------------------------------------
// Policy Configuration (persisted as JSON)
// ---------------------------------------------------------------------------

export type PolicyFeedbackConfig = {
  /** Operating mode */
  mode: PolicyMode;
  /** How often to recompute aggregates (ms). Default: 3600000 (1 hour) */
  aggregateIntervalMs: number;
  /** Outcome observation horizons in ms */
  outcomeHorizons: number[];
  /** Constraint rules */
  constraints: ConstraintRule[];
  /** Per-agent overrides (keyed by agentId) */
  agentOverrides?: Record<string, Partial<PolicyFeedbackConfig>>;
  /** Log retention: max age in days. Default: 90 */
  logRetentionDays: number;
  /** Whether to scope logs per-agent or globally. Default: true */
  perAgentScoping: boolean;
  /** Optional ranking weight overrides. When undefined, DEFAULT_RANKING_WEIGHTS are used. */
  rankingWeights?: Partial<RankingWeights>;
};

export type PolicyFeedbackFeatureFlags = {
  enableActionLogging: boolean;
  enableOutcomeLogging: boolean;
  enableRanking: boolean;
  enableConstraints: boolean;
};

// ---------------------------------------------------------------------------
// Candidate Actions & Scoring
// ---------------------------------------------------------------------------

export type CandidateAction = {
  /** Unique identifier for this candidate */
  id: string;
  /** Action type classification */
  actionType: ActionType;
  /** Tool or skill name, if applicable */
  toolName?: string;
  /** Description of what this action would do */
  description?: string;
  /** Additional metadata for scoring */
  metadata?: Record<string, unknown>;
};

export type PolicyContext = {
  /** Channel the interaction is on */
  channelId: string;
  /** Current hour of day (0-23) in the user's timezone */
  hourOfDay?: number;
  /** Number of recent agent actions in the current session */
  recentActionCount?: number;
  /** Time since last agent action in this session (ms) */
  timeSinceLastActionMs?: number;
  /** Number of consecutive agent messages without user reply */
  consecutiveIgnores?: number;
  /**
   * Extensible context for V2+ integration (user state, opportunity signals,
   * wearable data, calendar, etc.). Scoring components may read known keys
   * from this map without requiring a type change.
   */
  extensions?: Record<string, unknown>;
};

export type ScoredCandidate = {
  /** The candidate that was scored */
  candidate: CandidateAction;
  /** Computed score (0-1, higher is better) */
  score: number;
  /** Human-readable reasons for the score */
  reasons: string[];
  /** Whether this candidate should be suppressed */
  suppress: boolean;
  /** Which constraint triggered suppression, if any */
  suppressionRule?: string;
};

// ---------------------------------------------------------------------------
// Input Types
// ---------------------------------------------------------------------------

export type LogActionInput = {
  agentId: string;
  sessionKey: string;
  sessionId?: string;
  actionType: ActionType;
  channelId: string;
  accountId?: string;
  contextSummary?: string;
  toolName?: string;
  rationale?: string;
  metadata?: Record<string, unknown>;
};

export type LogOutcomeInput = {
  actionId: string;
  agentId: string;
  outcomeType: OutcomeType;
  value?: number;
  horizonMs?: number;
  metadata?: Record<string, unknown>;
};

export type RankCandidatesInput = {
  agentId: string;
  sessionKey: string;
  candidates: CandidateAction[];
  context: PolicyContext;
};

export type GetPolicyHintsInput = {
  agentId: string;
  sessionKey: string;
  channelId: string;
  context?: PolicyContext;
};

// ---------------------------------------------------------------------------
// Policy Hints
// ---------------------------------------------------------------------------

export type PolicyHints = {
  recommendation: "proceed" | "caution" | "suppress";
  reasons: string[];
  toneHints?: string[];
  timingHint?: string;
  fatigueLevel: number;
  activeConstraints: string[];
  mode: PolicyMode;
};

// ---------------------------------------------------------------------------
// Engine Status
// ---------------------------------------------------------------------------

export type PolicyFeedbackStatus = {
  mode: PolicyMode;
  actionLogSize: number;
  outcomeLogSize: number;
  aggregatesComputedAt?: string;
  aggregatesStale: boolean;
  constraintRulesLoaded: number;
  lastError?: string;
};

// ---------------------------------------------------------------------------
// Score Breakdown (returned by explainScore)
// ---------------------------------------------------------------------------

/** Detailed breakdown of how a candidate's score was computed. */
export type ScoreBreakdown = {
  candidateId: string;
  finalScore: number;
  factors: {
    name: string;
    value: number;
    description: string;
  }[];
  suppressed: boolean;
  suppressionRule: string | undefined;
};

// ---------------------------------------------------------------------------
// Engine Interface
// ---------------------------------------------------------------------------

export interface PolicyFeedbackEngine {
  /** Log a meaningful action taken by the system. Returns a unique action ID. */
  logAction(input: LogActionInput): Promise<{ actionId: string }>;

  /** Log a delayed or immediate outcome associated with a prior action. */
  logOutcome(input: LogOutcomeInput): Promise<void>;

  /**
   * Rank candidate actions given current context and policy state.
   * Returns scored candidates ordered by descending score.
   * In passive mode, returns all candidates with score=1 and no suppression.
   */
  rankCandidates(input: RankCandidatesInput): Promise<ScoredCandidate[]>;

  /**
   * Get policy hints for the current context.
   * Used by prompt injection (advisory mode) and orchestrator decisions.
   */
  getPolicyHints(input: GetPolicyHintsInput): Promise<PolicyHints>;

  /** Trigger aggregate recomputation from logs. Idempotent. */
  recomputeAggregates(agentId?: string): Promise<void>;

  /** Get current engine status for observability. */
  getStatus(): PolicyFeedbackStatus;

  /**
   * Explain the scoring breakdown for a specific candidate in a given context.
   *
   * @param candidateId - ID of the candidate to explain.
   * @param context - The policy context to evaluate against.
   * @param actionType - Optional action type for the synthetic candidate (defaults to 'agent_reply').
   * @returns A ScoreBreakdown with per-factor details, or undefined on error.
   */
  explainScore(
    candidateId: string,
    context: PolicyContext,
    actionType?: ActionType,
  ): Promise<ScoreBreakdown | undefined>;

  /**
   * Eagerly initialize all internal components in the correct dependency order.
   * Idempotent and never throws. Recommended to call after engine creation.
   */
  start(): void;
}
