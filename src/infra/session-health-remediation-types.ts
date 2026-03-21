/**
 * Session Health — Remediation Types
 *
 * Defines the action taxonomy, tier model, and remediation plan structure
 * for session lifecycle cleanup. This is the Phase 3A safety-first model:
 * report-only, preview-only, no mutations.
 *
 * Design principles:
 * - Every remediation action has a risk tier (0–3)
 * - Lower tiers are safer and can be automated earlier
 * - Higher tiers require explicit human approval
 * - Actions are either reversible (archive-first) or destructive
 * - The plan is generated from a raw snapshot — never executes anything
 * - The approval model is explicit: what can run unattended vs what needs review
 */

import type { SessionHealthClass, SessionHealthRawSnapshot } from "./session-health-types.js";

// ---------------------------------------------------------------------------
// Risk Tiers
// ---------------------------------------------------------------------------

/**
 * Risk tier for a remediation action.
 *
 * - **0 — Auto-Safe:** Only affects definitional garbage (crashed temp files).
 *   Can be automated without data loss risk. Operator may approve bulk automation.
 *
 * - **1 — Retention Cleanup:** Either archives orphaned artifacts or
 *   permanently removes artifacts that are already archived and past their
 *   retention window. Review the action list before enabling automation.
 *
 * - **2 — Index-Mutating:** Modifies the session index (sessions.json).
 *   Changes which sessions are visible/loadable. Transcript files may or may
 *   not be affected. Requires operator preview and confirmation per execution.
 *
 * - **3 — Destructive:** Permanently removes data. Cannot be undone.
 *   Always requires explicit operator confirmation. Never automated by default.
 */
export type RemediationRiskTier = 0 | 1 | 2 | 3;

export const REMEDIATION_TIER_LABELS: Record<RemediationRiskTier, string> = {
  0: "Auto-Safe",
  1: "Retention Cleanup (review list first)",
  2: "Index-Mutating",
  3: "Destructive",
};

export const REMEDIATION_TIER_DESCRIPTIONS: Record<RemediationRiskTier, string> = {
  0: "Only affects definitional garbage. Safe to automate without data loss risk.",
  1: "Archives orphans or permanently removes already-archived artifacts past retention. Review the list before enabling.",
  2: "Modifies the session index. Changes which sessions are visible/loadable.",
  3: "Permanently removes data. Cannot be undone. Always requires explicit confirmation.",
};

// ---------------------------------------------------------------------------
// Action Kinds
// ---------------------------------------------------------------------------

/**
 * Specific remediation action kinds. Each maps to exactly one risk tier.
 *
 * Naming convention: `{verb}-{target}` where verb indicates the operation
 * and target indicates what is affected.
 */
export type RemediationActionKind =
  // Tier 0 — Auto-Safe
  | "cleanup-orphaned-tmp"

  // Tier 1 — Reversible
  | "archive-orphan-transcripts"
  | "archive-stale-deleted-transcripts"
  | "archive-stale-reset-transcripts"

  // Tier 2 — Index-Mutating
  | "reconcile-index-phantoms"
  | "prune-stale-cron-runs"
  | "prune-stale-subagents"
  | "prune-stale-heartbeats"
  | "prune-stale-acp"

  // Tier 3 — Destructive
  | "enforce-disk-budget"
  | "purge-archived-artifacts"
  | "bulk-class-prune";

/**
 * Static mapping from action kind to its risk tier.
 * This is the source of truth for tier classification.
 */
export const ACTION_KIND_TIERS: Record<RemediationActionKind, RemediationRiskTier> = {
  // Tier 0
  "cleanup-orphaned-tmp": 0,

  // Tier 1
  "archive-orphan-transcripts": 1,
  "archive-stale-deleted-transcripts": 1,
  "archive-stale-reset-transcripts": 1,

  // Tier 2
  "reconcile-index-phantoms": 2,
  "prune-stale-cron-runs": 2,
  "prune-stale-subagents": 2,
  "prune-stale-heartbeats": 2,
  "prune-stale-acp": 2,

  // Tier 3
  "enforce-disk-budget": 3,
  "purge-archived-artifacts": 3,
  "bulk-class-prune": 3,
};

// ---------------------------------------------------------------------------
// Remediation Action
// ---------------------------------------------------------------------------

/**
 * A single proposed remediation action.
 *
 * This is a *recommendation* — it describes what WOULD happen, not what DID happen.
 * No action in a RemediationPlan mutates state.
 */
export type RemediationAction = {
  /** Unique identifier for this action within the plan. */
  id: string;

  /** The kind of action. Determines behavior and tier. */
  kind: RemediationActionKind;

  /** Risk tier (derived from kind, included for convenience). */
  tier: RemediationRiskTier;

  /** Human-readable label for display. */
  label: string;

  /** Detailed description of what this action would do. */
  description: string;

  /** Why this action is being recommended (linked to health indicator). */
  reason: string;

  /** Estimated impact of executing this action. */
  estimatedImpact: RemediationImpact;

  /** Whether the action is reversible (archive-first) or permanent. */
  reversible: boolean;

  /** Action kinds that should run before this one (if any). */
  prerequisites: RemediationActionKind[];
};

export type RemediationImpact = {
  /** Number of artifacts (files or index entries) affected. */
  affectedCount: number;

  /**
   * Estimated bytes that would be freed or archived.
   * Null means no honest estimate is available from the current snapshot.
   */
  estimatedBytes: number | null;

  /** Session classes affected by this action (if applicable). */
  affectedClasses: SessionHealthClass[];
};

// ---------------------------------------------------------------------------
// Remediation Plan
// ---------------------------------------------------------------------------

/**
 * A complete remediation plan generated from a health snapshot.
 *
 * This is the Phase 3A output: a structured, human-reviewable report
 * that describes what WOULD be cleaned and why. It never executes anything.
 */
export type RemediationPlan = {
  /** When this plan was generated. */
  generatedAt: string;

  /** When the source snapshot was captured. */
  snapshotAt: string;

  /** Summary statistics. */
  summary: RemediationPlanSummary;

  /** Actions grouped by risk tier. */
  tiers: RemediationTierGroup[];

  /** The approval model: what can run automatically vs what needs review. */
  approvalModel: ApprovalModel;
};

export type RemediationPlanSummary = {
  /** Total number of proposed actions. */
  totalActions: number;

  /** Total estimated bytes that could be recovered across all actions. */
  estimatedRecoverableBytes: number;

  /** Count of actions per tier. */
  actionCountByTier: Record<RemediationRiskTier, number>;

  /** Highest tier present in the plan (determines overall approval requirement). */
  highestTierRequired: RemediationRiskTier;

  /** Human-readable recommendation for what to do next. */
  recommendation: string;
};

export type RemediationTierGroup = {
  /** Risk tier (0–3). */
  tier: RemediationRiskTier;

  /** Human-readable tier label. */
  label: string;

  /** Tier description. */
  description: string;

  /** Whether operator approval is required before execution. */
  approvalRequired: boolean;

  /** Actions in this tier. */
  actions: RemediationAction[];
};

// ---------------------------------------------------------------------------
// Approval Model
// ---------------------------------------------------------------------------

/**
 * Defines the approval boundaries for remediation actions.
 *
 * This model is the safety contract between the system and the operator.
 * It explicitly separates what can be automated from what requires human review.
 */
export type ApprovalModel = {
  /**
   * Actions that can run without any confirmation once the operator
   * enables automated cleanup. Currently: Tier 0 only.
   */
  autoApprovable: RemediationActionKind[];

  /**
   * Actions that require a dry-run preview before first execution,
   * but can be automated after initial review. Currently: Tier 1.
   */
  previewThenAutomate: RemediationActionKind[];

  /**
   * Actions that require explicit operator confirmation every time.
   * Currently: Tier 2.
   */
  explicitApprovalRequired: RemediationActionKind[];

  /**
   * Actions that should never be automated. Always require manual review
   * and explicit confirmation. Currently: Tier 3.
   */
  neverAutomate: RemediationActionKind[];
};

// ---------------------------------------------------------------------------
// Execution Types (Phase 3C)
// ---------------------------------------------------------------------------

/**
 * Per-action execution result produced by an action executor.
 */
export type ActionExecutionResult = {
  /** The action ID from the plan. */
  id: string;

  /** The action kind. */
  kind: RemediationActionKind;

  /** Risk tier. */
  tier: RemediationRiskTier;

  /** Outcome of execution. */
  status: "complete" | "skipped" | "failed" | "refused";

  /** Number of artifacts actually removed/renamed. */
  artifactsRemoved: number;

  /** Actual bytes freed (measured, not estimated). */
  bytesFreed: number;

  /** Human-readable detail message. */
  detail?: string;

  /** Warning messages (e.g., partial failures). */
  warnings?: string[];

  /** Error message when status is "failed" or "refused". */
  error?: string;
};

/**
 * Summary of a full execution run.
 */
export type ExecutionSummary = {
  executed: number;
  skipped: number;
  failed: number;
  refused: number;
  totalBytesFreed: number;
  storageBefore: number;
  storageAfter: number;
};

/**
 * Complete result from a remediation execution pass.
 */
export type ExecutionResult = {
  executedAt: string;
  actions: ActionExecutionResult[];
  summary: ExecutionSummary;
};

/**
 * Maximum risk tier the v1 executor supports.
 * Hard safety boundary — anything above this is refused.
 */
export const V1_MAX_EXECUTION_TIER: RemediationRiskTier = 1;

// ---------------------------------------------------------------------------
// Plan Generator Input
// ---------------------------------------------------------------------------

/**
 * Options for the plan generator.
 * Snapshot is the only required input — the generator is a pure function.
 */
export type BuildRemediationPlanOptions = {
  /** The raw health snapshot to analyze. */
  snapshot: SessionHealthRawSnapshot;

  /**
   * Override retention defaults per session class (milliseconds).
   * If not provided, uses the built-in defaults from the Phase 1 taxonomy.
   */
  retentionOverrides?: Partial<Record<SessionHealthClass, number>>;

  /**
   * Whether to include actions that have zero estimated impact.
   * Default: false (omit no-op actions for cleaner reports).
   */
  includeNoOpActions?: boolean;
};
