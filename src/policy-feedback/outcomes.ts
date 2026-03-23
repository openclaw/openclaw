/**
 * Outcome tracker: append-only outcome logging for the policy feedback subsystem.
 *
 * The OutcomeTracker wraps persistence functions with feature-flag gating,
 * error safety, and query helpers. Like the ledger, failures are swallowed.
 */

import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { featureFlagsForMode } from "./config.js";
import { appendOutcome, readOutcomes } from "./persistence.js";
import type { LogOutcomeInput, OutcomeRecord, PolicyFeedbackConfig } from "./types.js";

const log = createSubsystemLogger("policy-feedback:outcomes");

// ---------------------------------------------------------------------------
// OutcomeTracker
// ---------------------------------------------------------------------------

export class OutcomeTracker {
  private readonly home: string;
  private readonly config: PolicyFeedbackConfig;

  constructor(storageDir: string, config: PolicyFeedbackConfig) {
    this.home = storageDir;
    this.config = config;
  }

  /**
   * Log an outcome linked to a prior action.
   * No-op when outcome logging is disabled.
   * Never throws.
   */
  async logOutcome(input: LogOutcomeInput): Promise<OutcomeRecord> {
    const flags = featureFlagsForMode(this.config.mode);
    const outcomeId = crypto.randomUUID();
    const record: OutcomeRecord = {
      id: outcomeId,
      timestamp: new Date().toISOString(),
      actionId: input.actionId,
      agentId: input.agentId,
      outcomeType: input.outcomeType,
      value: input.value,
      horizonMs: input.horizonMs,
      metadata: input.metadata,
    };

    if (!flags.enableOutcomeLogging) {
      return record;
    }

    try {
      const opts = this.config.perAgentScoping
        ? { agentId: input.agentId, home: this.home }
        : { home: this.home };
      await appendOutcome(record, opts);
    } catch (err: unknown) {
      log.warn("Failed to log outcome", { error: String(err) });
    }

    return record;
  }

  /**
   * Query outcomes with optional filters.
   * Returns an empty array on error.
   */
  async queryOutcomes(filter: {
    actionId?: string;
    agentId?: string;
    since?: number;
    limit?: number;
  }): Promise<OutcomeRecord[]> {
    try {
      // When perAgentScoping is enabled and an agentId is provided, read
      // from the per-agent path (where logOutcome writes). Otherwise fall
      // back to the global path.
      const opts =
        this.config.perAgentScoping && filter.agentId
          ? { agentId: filter.agentId, home: this.home }
          : { home: this.home };
      let outcomes = await readOutcomes(opts);

      if (filter.actionId !== undefined) {
        outcomes = outcomes.filter((o) => o.actionId === filter.actionId);
      }

      if (filter.since !== undefined) {
        outcomes = outcomes.filter((o) => new Date(o.timestamp).getTime() >= filter.since!);
      }

      if (filter.limit !== undefined && filter.limit > 0) {
        outcomes = outcomes.slice(-filter.limit);
      }

      return outcomes;
    } catch (err: unknown) {
      log.warn("Failed to query outcomes", { error: String(err) });
      return [];
    }
  }

  /**
   * Get all outcomes linked to a specific action.
   * Pass agentId when perAgentScoping is enabled to read from the correct path.
   */
  async getOutcomesForAction(actionId: string, agentId?: string): Promise<OutcomeRecord[]> {
    return this.queryOutcomes({ actionId, agentId });
  }
}
