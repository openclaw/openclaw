/**
 * Action ledger: append-only action logging for the policy feedback subsystem.
 *
 * The ActionLedger wraps persistence functions with feature-flag gating,
 * error safety, and query helpers. Logging failures are swallowed so they
 * never interrupt the caller's hot path.
 */

import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { featureFlagsForMode } from "./config.js";
import { appendAction, readActions } from "./persistence.js";
import type { ActionRecord, LogActionInput, PolicyFeedbackConfig } from "./types.js";

const log = createSubsystemLogger("policy-feedback:ledger");

// ---------------------------------------------------------------------------
// ActionLedger
// ---------------------------------------------------------------------------

export class ActionLedger {
  private readonly home: string;
  private readonly config: PolicyFeedbackConfig;

  constructor(storageDir: string, config: PolicyFeedbackConfig) {
    this.home = storageDir;
    this.config = config;
  }

  /**
   * Log an action. Returns the created ActionRecord.
   * No-op (returns a stub record) when action logging is disabled.
   * Never throws — logs a warning on failure and returns a stub.
   */
  async logAction(input: LogActionInput): Promise<ActionRecord> {
    const flags = featureFlagsForMode(this.config.mode);
    const actionId = crypto.randomUUID();
    const record: ActionRecord = {
      id: actionId,
      timestamp: new Date().toISOString(),
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      sessionId: input.sessionId,
      actionType: input.actionType,
      channelId: input.channelId,
      accountId: input.accountId,
      contextSummary: input.contextSummary,
      toolName: input.toolName,
      rationale: input.rationale,
      metadata: input.metadata,
      policyMode: this.config.mode,
    };

    if (!flags.enableActionLogging) {
      return record;
    }

    try {
      const opts = this.config.perAgentScoping
        ? { agentId: input.agentId, home: this.home }
        : { home: this.home };
      await appendAction(record, opts);
    } catch (err: unknown) {
      // Fail-open: logging should never break the caller
      log.warn("Failed to log action", { error: String(err) });
    }

    return record;
  }

  /**
   * Query actions with optional filters.
   * Returns an empty array on error.
   */
  async queryActions(filter: {
    userId?: string;
    since?: number;
    limit?: number;
  }): Promise<ActionRecord[]> {
    try {
      const opts =
        filter.userId && this.config.perAgentScoping
          ? { agentId: filter.userId, home: this.home }
          : { home: this.home };
      let actions = await readActions(opts);

      if (filter.since !== undefined) {
        actions = actions.filter((a) => new Date(a.timestamp).getTime() >= filter.since!);
      }

      if (filter.limit !== undefined && filter.limit > 0) {
        // Return the most recent N records
        actions = actions.slice(-filter.limit);
      }

      return actions;
    } catch (err: unknown) {
      log.warn("Failed to query actions", { error: String(err) });
      return [];
    }
  }

  /**
   * Get recent actions for a user/agent, most recent last.
   * Convenience wrapper around queryActions.
   */
  async getRecentActions(userId: string, limit = 20): Promise<ActionRecord[]> {
    return this.queryActions({ userId, limit });
  }
}
