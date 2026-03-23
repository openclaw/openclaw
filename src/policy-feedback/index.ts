/**
 * Public API barrel for the policy feedback subsystem.
 *
 * Re-exports the engine, factory, all types, and individual component
 * classes for testing and advanced usage.
 *
 * @example
 * ```ts
 * import { createPolicyFeedbackEngine } from "./policy-feedback/index.js";
 *
 * const engine = await createPolicyFeedbackEngine({ agentId: "my-agent" });
 * const status = engine.getStatus();
 * ```
 */

// Engine
export {
  PolicyFeedbackEngineImpl as PolicyFeedbackEngine,
  PolicyFeedbackEngineImpl,
  createPolicyFeedbackEngine,
} from "./engine.js";
export type { ScoreBreakdown } from "./types.js";

// All types
export type {
  ActionRecord,
  ActionType,
  ActionTypeStats,
  AggregateStats,
  CandidateAction,
  ConstraintCondition,
  ConstraintRule,
  GetPolicyHintsInput,
  HourStats,
  LogActionInput,
  LogOutcomeInput,
  OutcomeRecord,
  OutcomeType,
  PolicyContext,
  PolicyFeedbackConfig,
  PolicyFeedbackEngine as PolicyFeedbackEngineInterface,
  PolicyFeedbackFeatureFlags,
  PolicyFeedbackStatus,
  PolicyHints,
  PolicyMode,
  RankCandidatesInput,
  ScoredCandidate,
} from "./types.js";

// Individual classes for testing / advanced composition
export { ActionLedger } from "./ledger.js";
export { OutcomeTracker } from "./outcomes.js";
export { AggregateComputer } from "./aggregates.js";
export { CandidateRanker } from "./ranker.js";
export { ConstraintLayer } from "./constraints.js";

// Constraint pure functions (for independent testing)
export {
  applyMaxNudgesPerDay,
  applyRepeatedIgnores,
  applyCooldownPeriod,
  applyUncertaintyThreshold,
  applyCustomConstraint,
  evaluateCondition,
} from "./constraints.js";

// Config utilities
export {
  getDefaultConfig,
  loadConfig,
  saveConfig,
  mergeConfig,
  resolveAgentConfig,
  featureFlagsForMode,
} from "./config.js";

// Persistence utilities
export { pruneOldRecords } from "./persistence.js";

// Hook integration bridge
export { registerPolicyFeedbackHooks, clearPolicyFeedbackHookState } from "./hooks.js";
export type { PolicyFeedbackHooksOptions } from "./hooks.js";

// High-level initialization (for gateway startup)
export { initializePolicyFeedback } from "./init.js";

// Gateway bridge (singleton accessor for subsystems)
export {
  getPolicyHintsSafe,
  getPolicyHintsForPrompt,
  logPolicyAction,
  isPolicyFeedbackActive,
  getPolicyFeedbackMode,
} from "./gateway-bridge.js";

// Prompt hint formatting
export { formatPolicyHintsForPrompt } from "./prompt-hints.js";
