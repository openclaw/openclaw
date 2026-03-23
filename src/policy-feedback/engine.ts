/**
 * PolicyFeedbackEngine: main engine composing all subsystem components.
 *
 * Composes ActionLedger, OutcomeTracker, AggregateComputer, CandidateRanker,
 * and ConstraintLayer into a single cohesive engine that implements the
 * PolicyFeedbackEngine interface.
 *
 * All public methods are error-safe (never throw). Failures are logged and
 * gracefully degraded.
 */

import os from "node:os";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { AggregateComputer } from "./aggregates.js";
import { featureFlagsForMode, loadConfig, resolveAgentConfig } from "./config.js";
import { ConstraintLayer } from "./constraints.js";
import { ActionLedger } from "./ledger.js";
import { OutcomeTracker } from "./outcomes.js";
import { CandidateRanker } from "./ranker.js";
import type {
  ActionRecord,
  ActionType,
  GetPolicyHintsInput,
  LogActionInput,
  LogOutcomeInput,
  OutcomeRecord,
  PolicyContext,
  PolicyFeedbackConfig,
  PolicyFeedbackEngine,
  PolicyFeedbackStatus,
  PolicyHints,
  PolicyMode,
  RankCandidatesInput,
  ScoreBreakdown,
  ScoredCandidate,
} from "./types.js";

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = createSubsystemLogger("policy-feedback");

// ---------------------------------------------------------------------------
// Default storage directory
// ---------------------------------------------------------------------------

/**
 * Resolve the home directory for policy feedback storage.
 *
 * Checks OPENCLAW_STATE_DIR first (for deployments with ephemeral home
 * directories, e.g. Railway/Docker where ~ is wiped on redeploy but
 * a persistent volume is mounted at a fixed path).
 * Falls back to os.homedir().
 */
function defaultHome(): string {
  return process.env.OPENCLAW_STATE_DIR ?? os.homedir();
}

// Re-export ScoreBreakdown from types for backward compatibility.
export type { ScoreBreakdown } from "./types.js";

// ---------------------------------------------------------------------------
// PolicyFeedbackEngineImpl
// ---------------------------------------------------------------------------

export class PolicyFeedbackEngineImpl implements PolicyFeedbackEngine {
  private readonly home: string;
  private readonly config: PolicyFeedbackConfig;

  // Lazy-initialized components
  private _ledger: ActionLedger | undefined;
  private _outcomeTracker: OutcomeTracker | undefined;
  private _aggregates: AggregateComputer | undefined;
  private _ranker: CandidateRanker | undefined;
  private _constraints: ConstraintLayer | undefined;

  private _started = false;
  private lastError: string | undefined;
  private actionCount = 0;
  private outcomeCount = 0;
  private lastActionTime: string | undefined;

  constructor(home: string, config: PolicyFeedbackConfig) {
    this.home = home;
    this.config = config;
  }

  // -------------------------------------------------------------------------
  // Lazy component accessors
  // -------------------------------------------------------------------------

  private get ledger(): ActionLedger {
    if (!this._ledger) {
      this._ledger = new ActionLedger(this.home, this.config);
    }
    return this._ledger;
  }

  private get outcomeTracker(): OutcomeTracker {
    if (!this._outcomeTracker) {
      this._outcomeTracker = new OutcomeTracker(this.home, this.config);
    }
    return this._outcomeTracker;
  }

  private get aggregates(): AggregateComputer {
    if (!this._aggregates) {
      this._aggregates = new AggregateComputer();
    }
    return this._aggregates;
  }

  private get ranker(): CandidateRanker {
    if (!this._ranker) {
      this._ranker = new CandidateRanker(
        this.aggregates,
        this.config,
        this.ledger,
        this.config.rankingWeights,
      );
    }
    return this._ranker;
  }

  private get constraints(): ConstraintLayer {
    if (!this._constraints) {
      this._constraints = new ConstraintLayer(this.config);
    }
    return this._constraints;
  }

  // -------------------------------------------------------------------------
  // Eager initialization
  // -------------------------------------------------------------------------

  /**
   * Eagerly initialize all internal components in the correct dependency order:
   * ledger -> outcomeTracker -> aggregates -> ranker -> constraints.
   *
   * Idempotent (calling twice is a no-op) and never throws.
   * The lazy getters remain as a fallback for callers that skip start().
   */
  start(): void {
    if (this._started) {
      return;
    }
    try {
      // 1. Ledger (no deps)
      this._ledger = this._ledger ?? new ActionLedger(this.home, this.config);

      // 2. Outcome tracker (no deps)
      this._outcomeTracker = this._outcomeTracker ?? new OutcomeTracker(this.home, this.config);

      // 3. Aggregates (no deps)
      this._aggregates = this._aggregates ?? new AggregateComputer();

      // 4. Ranker (depends on aggregates + ledger)
      this._ranker =
        this._ranker ??
        new CandidateRanker(
          this._aggregates,
          this.config,
          this._ledger,
          this.config.rankingWeights,
        );

      // 5. Constraints (depends on config only)
      this._constraints = this._constraints ?? new ConstraintLayer(this.config);

      this._started = true;
      log.debug("engine started — all components initialized");
    } catch (err: unknown) {
      this.lastError = `start failed: ${String(err)}`;
      log.warn("Engine.start failed", { error: String(err) });
    }
  }

  // -------------------------------------------------------------------------
  // PolicyFeedbackEngine interface
  // -------------------------------------------------------------------------

  /**
   * Log an action taken by the system. Delegates to ActionLedger.
   *
   * Records the action in the append-only JSONL ledger for later
   * aggregate computation and outcome correlation.
   * Never throws -- returns `{ actionId: "error" }` on failure.
   *
   * @param input - Action details including agent, session, type, and channel.
   * @returns Object containing the unique action ID.
   */
  async logAction(input: LogActionInput): Promise<{ actionId: string }> {
    try {
      const record = await this.ledger.logAction(input);
      this.actionCount++;
      this.lastActionTime = new Date().toISOString();
      log.debug("action logged", {
        actionId: record.id,
        agentId: input.agentId,
        actionType: input.actionType,
        channelId: input.channelId,
      });
      return { actionId: record.id };
    } catch (err: unknown) {
      this.lastError = `logAction failed: ${String(err)}`;
      log.warn("Engine.logAction failed", { error: String(err), agentId: input.agentId });
      return { actionId: "error" };
    }
  }

  /**
   * Log a delayed or immediate outcome associated with a prior action.
   *
   * Delegates to OutcomeTracker, then triggers an incremental aggregate
   * update if the matching action can be found in recent history.
   * Never throws.
   *
   * @param input - Outcome details including the linked action ID and outcome type.
   */
  async logOutcome(input: LogOutcomeInput): Promise<void> {
    try {
      const outcomeRecord = await this.outcomeTracker.logOutcome(input);
      this.outcomeCount++;
      log.debug("outcome tracked", {
        outcomeId: outcomeRecord.id,
        actionId: input.actionId,
        outcomeType: input.outcomeType,
        agentId: input.agentId,
      });

      // Trigger incremental aggregate update.
      // We need the original action to update aggregates properly.
      const recentActions = await this.ledger.getRecentActions(input.agentId, 50);
      const matchingAction = recentActions.find((a) => a.id === input.actionId);

      if (matchingAction) {
        this.aggregates.updateAggregatesIncremental(matchingAction, outcomeRecord);
      }
    } catch (err: unknown) {
      this.lastError = `logOutcome failed: ${String(err)}`;
      log.warn("Engine.logOutcome failed", { error: String(err), actionId: input.actionId });
    }
  }

  /**
   * Rank candidate actions given current context and policy state.
   *
   * Scores each candidate via the CandidateRanker composite heuristic,
   * then applies the ConstraintLayer to flag suppressions.
   * Never throws -- returns all candidates with score 0.5 on failure.
   *
   * @param input - Candidates to rank plus the current policy context.
   * @returns Scored candidates ordered by descending score.
   */
  async rankCandidates(input: RankCandidatesInput): Promise<ScoredCandidate[]> {
    try {
      // Score via ranker
      const scored = await this.ranker.rankCandidates(input);

      // Apply constraints (pass aggregate stats for data-dependent rules like low_effectiveness)
      const flags = featureFlagsForMode(this.config.mode);
      let result = scored;
      if (flags.enableConstraints) {
        const aggregatesList = await this.aggregates.getAggregates();
        result = this.constraints.applyConstraints(scored, input.context, {
          stats: aggregatesList[0],
        });
      }

      // Check if no-op is preferred by the constraint layer
      const noOpPreferred = this.constraints.isNoOpPreferred(input.context);
      if (noOpPreferred) {
        log.debug("no-op preferred by constraint layer", {
          agentId: input.agentId,
          channelId: input.context.channelId,
        });
      }

      const suppressedCount = result.filter((c) => c.suppress).length;
      log.debug("ranking computed", {
        agentId: input.agentId,
        candidateCount: input.candidates.length,
        topScore: result[0]?.score,
        suppressedCount,
      });

      // Log individual constraint firings
      for (const candidate of result) {
        if (candidate.suppress && candidate.suppressionRule) {
          log.debug("constraint fired", {
            candidateId: candidate.candidate.id,
            rule: candidate.suppressionRule,
            score: candidate.score,
          });
        }
      }

      return result;
    } catch (err: unknown) {
      this.lastError = `rankCandidates failed: ${String(err)}`;
      log.warn("Engine.rankCandidates failed", { error: String(err) });

      // Fallback: return candidates with neutral scores
      return input.candidates.map((candidate) => ({
        candidate,
        score: 0.5,
        reasons: ["Ranking failed — returning base score"],
        suppress: false,
      }));
    }
  }

  /**
   * Get policy hints for the current context.
   *
   * Returns advisory guidance about whether the agent should act,
   * including fatigue level, active constraints, and tone hints.
   * Delegates to ranker's getPolicyHints.
   * Never throws -- returns safe "proceed" defaults on failure.
   *
   * @param input - Context for hint generation (agent, session, channel).
   * @returns Policy hints with recommendation, reasons, and fatigue level.
   */
  async getPolicyHints(input: GetPolicyHintsInput): Promise<PolicyHints> {
    try {
      const hints = await this.ranker.getPolicyHints(input);

      // Apply constraint layer on top of ranker hints so that built-in rules
      // (cooldown, repeated ignores, time_of_day_block, etc.) can escalate
      // the recommendation to "suppress" even when the score is above threshold.
      const flags = featureFlagsForMode(this.config.mode);
      if (flags.enableConstraints && hints.recommendation !== "suppress") {
        const context = input.context ?? { channelId: input.channelId };
        const noOpPreferred = this.constraints.isNoOpPreferred(context);
        if (noOpPreferred) {
          hints.recommendation = "suppress";
          hints.reasons.push("Multiple constraint rules triggered — suppress recommended");
          hints.activeConstraints = this.constraints.getActiveConstraints();
        }
      }

      log.debug("policy hints generated", {
        agentId: input.agentId,
        recommendation: hints.recommendation,
        fatigueLevel: hints.fatigueLevel,
      });
      return hints;
    } catch (err: unknown) {
      this.lastError = `getPolicyHints failed: ${String(err)}`;
      log.warn("Engine.getPolicyHints failed", { error: String(err) });

      return {
        recommendation: "proceed",
        reasons: ["Policy hints unavailable — defaulting to proceed"],
        fatigueLevel: 0,
        activeConstraints: [],
        mode: this.config.mode,
      };
    }
  }

  /**
   * Trigger full aggregate recomputation from action and outcome logs.
   *
   * Reads all persisted JSONL records, recomputes effectiveness stats,
   * and writes the result to disk. Idempotent and safe to call at any time.
   * Never throws.
   *
   * @param agentId - Optional agent ID to scope the recomputation.
   */
  async recomputeAggregates(agentId?: string): Promise<void> {
    try {
      await this.aggregates.recomputeAggregates(this.home, { agentId });
      log.debug("aggregates recomputed", { agentId });
    } catch (err: unknown) {
      this.lastError = `recomputeAggregates failed: ${String(err)}`;
      log.warn("Engine.recomputeAggregates failed", { error: String(err) });
    }
  }

  // -------------------------------------------------------------------------
  // Observability / debug methods
  // -------------------------------------------------------------------------

  /**
   * Get current engine status for observability dashboards.
   *
   * Returns a snapshot of operational counters, mode, and the last error
   * (if any). Useful for health checks and monitoring.
   *
   * @returns Status object with mode, log sizes, staleness, and error state.
   */
  getStatus(): PolicyFeedbackStatus {
    return {
      mode: this.config.mode,
      actionLogSize: this.actionCount,
      outcomeLogSize: this.outcomeCount,
      aggregatesComputedAt: undefined,
      aggregatesStale: true,
      constraintRulesLoaded: this.config.constraints.length,
      lastError: this.lastError,
    };
  }

  /**
   * Get the current operating mode.
   *
   * @returns The policy mode: "off", "passive", "advisory", or "active".
   */
  getMode(): PolicyMode {
    return this.config.mode;
  }

  /** The resolved home directory used for storage paths. */
  getHome(): string {
    return this.home;
  }

  /** Read-only access to the resolved config for init/maintenance callers. */
  getResolvedConfig(): Readonly<PolicyFeedbackConfig> {
    return this.config;
  }

  /**
   * Get debug info: a comprehensive snapshot of the engine's internal state.
   *
   * Includes the current mode, feature flags, storage directory, action/outcome
   * counts, aggregate summary, and active constraint descriptions.
   *
   * @returns Debug info object with all engine state for inspection.
   */
  getDebugInfo(): {
    mode: PolicyMode;
    featureFlags: ReturnType<typeof featureFlagsForMode>;
    storageDir: string;
    actionCount: number;
    outcomeCount: number;
    constraintRules: number;
    lastError: string | undefined;
    lastActionTime: string | undefined;
    activeConstraints: string[];
    aggregateSummary: { totalActions: number; totalOutcomes: number } | undefined;
  } {
    // Fetch aggregate summary if available (non-blocking since getAggregates
    // returns cached data synchronously via the promise wrapper)
    let aggregateSummary: { totalActions: number; totalOutcomes: number } | undefined;
    try {
      // Access cached aggregates through the computer's synchronous path
      const agg = this.aggregates;
      // We can't await here, so just return what we know from counters
      aggregateSummary = {
        totalActions: this.actionCount,
        totalOutcomes: this.outcomeCount,
      };
      // Ensure the aggregates component is initialized
      void agg;
    } catch {
      aggregateSummary = undefined;
    }

    return {
      mode: this.config.mode,
      featureFlags: featureFlagsForMode(this.config.mode),
      storageDir: this.home,
      actionCount: this.actionCount,
      outcomeCount: this.outcomeCount,
      constraintRules: this.config.constraints.length,
      lastError: this.lastError,
      lastActionTime: this.lastActionTime,
      activeConstraints: this.constraints.getActiveConstraints(),
      aggregateSummary,
    };
  }

  /**
   * Explain the scoring breakdown for a specific candidate in a given context.
   *
   * Ranks the candidate using the full scoring pipeline, then returns a
   * detailed factor-by-factor breakdown showing each scoring component's
   * contribution. Useful for debugging why a particular action was scored
   * high or low, or why it was suppressed.
   *
   * @param candidateId - ID of the candidate to explain (used to build a synthetic candidate).
   * @param context - The policy context to evaluate against.
   * @returns A ScoreBreakdown with per-factor details, or undefined on error.
   */
  async explainScore(
    candidateId: string,
    context: PolicyContext,
    actionType?: ActionType,
  ): Promise<ScoreBreakdown | undefined> {
    try {
      const candidate = {
        id: candidateId,
        actionType: actionType ?? "agent_reply",
        description: `Explanation candidate ${candidateId}`,
      };

      const scored = await this.ranker.rankCandidates({
        agentId: "__explain__",
        sessionKey: "__explain__",
        candidates: [candidate],
        context,
      });

      const result = scored[0];
      if (!result) {
        return undefined;
      }

      // Apply constraints to get suppression info
      const flags = featureFlagsForMode(this.config.mode);
      let constrained = [result];
      if (flags.enableConstraints) {
        const aggregatesList = await this.aggregates.getAggregates();
        constrained = this.constraints.applyConstraints([result], context, {
          stats: aggregatesList[0],
        });
      }
      const final = constrained[0] ?? result;

      // Parse the reasons into structured factors.
      // Reasons from the ranker follow patterns like "Base score: 50",
      // "Historical effectiveness: +5.0", "Intervention fatigue: -10.0", etc.
      const factors = final.reasons.map((reason) => {
        const colonIdx = reason.indexOf(":");
        const name = colonIdx > 0 ? reason.slice(0, colonIdx).trim() : reason;
        const valueStr = colonIdx > 0 ? reason.slice(colonIdx + 1).trim() : "0";
        const numMatch = valueStr.match(/[+-]?\d+(\.\d+)?/);
        const value = numMatch ? Number.parseFloat(numMatch[0]) : 0;
        return { name, value, description: reason };
      });

      return {
        candidateId,
        finalScore: final.score,
        factors,
        suppressed: final.suppress,
        suppressionRule: final.suppressionRule,
      };
    } catch (err: unknown) {
      log.warn("explainScore failed", { error: String(err), candidateId });
      return undefined;
    }
  }

  /**
   * Get recent action+outcome history for a user/agent, useful for debugging.
   *
   * Fetches recent actions from the ledger and their associated outcomes
   * from the outcome tracker, pairing them into a combined timeline.
   *
   * @param userId - The agent/user ID to query history for.
   * @param limit - Maximum number of action records to return (default 20).
   * @returns Array of action records with their paired outcomes.
   */
  async getRecentHistory(
    userId: string,
    limit = 20,
  ): Promise<{ action: ActionRecord; outcomes: OutcomeRecord[] }[]> {
    try {
      const actions = await this.ledger.getRecentActions(userId, limit);
      const result: { action: ActionRecord; outcomes: OutcomeRecord[] }[] = [];

      for (const action of actions) {
        const outcomes = await this.outcomeTracker.getOutcomesForAction(action.id, action.agentId);
        result.push({ action, outcomes });
      }

      log.debug("recent history fetched", { userId, count: result.length });
      return result;
    } catch (err: unknown) {
      log.warn("getRecentHistory failed", { error: String(err), userId });
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a PolicyFeedbackEngineImpl with resolved config and storage dir.
 *
 * Loads config from disk, merges with defaults, applies any explicit
 * overrides, and resolves per-agent config if an agent ID is provided.
 *
 * @param options.home - Override the home directory for storage resolution.
 * @param options.config - Partial config overrides merged on top of loaded config.
 * @param options.agentId - Agent ID for per-agent config resolution.
 * @returns A fully configured PolicyFeedbackEngineImpl instance.
 */
export async function createPolicyFeedbackEngine(options?: {
  home?: string;
  config?: Partial<PolicyFeedbackConfig>;
  agentId?: string;
}): Promise<PolicyFeedbackEngineImpl> {
  const home = options?.home ?? defaultHome();

  // Load config from disk + env + defaults
  let config = await loadConfig();

  // Apply any explicit overrides
  if (options?.config) {
    config = { ...config, ...options.config };
  }

  // Apply per-agent overrides
  if (options?.agentId) {
    config = resolveAgentConfig(config, options.agentId);
  }

  const engine = new PolicyFeedbackEngineImpl(home, config);
  log.debug("engine created", { home, mode: config.mode });

  return engine;
}
