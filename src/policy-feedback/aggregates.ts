/**
 * Aggregate computation for the policy feedback subsystem.
 *
 * Reads action and outcome logs, computes per-action-type effectiveness
 * stats, time-of-day buckets, fatigue correlation, and per-channel stats.
 * Supports both full recompute and incremental update.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { readAggregates, streamActions, streamOutcomes, writeAggregates } from "./persistence.js";
import type {
  ActionRecord,
  ActionType,
  ActionTypeStats,
  AggregateStats,
  HourStats,
  OutcomeRecord,
} from "./types.js";
// readActions/readOutcomes kept available via re-export from persistence for
// small-read call sites; recomputeAggregates uses streamActions/streamOutcomes
// for constant-memory line-by-line reading of large JSONL files.

const log = createSubsystemLogger("policy-feedback:aggregates");

// ---------------------------------------------------------------------------
// Time-of-day period helpers
// ---------------------------------------------------------------------------

export type TimePeriod = "morning" | "afternoon" | "evening" | "night";

/** Map an hour (0-23) to a named period. */
export function hourToPeriod(hour: number): TimePeriod {
  if (hour >= 6 && hour < 12) {
    return "morning";
  }
  if (hour >= 12 && hour < 18) {
    return "afternoon";
  }
  if (hour >= 18 && hour < 22) {
    return "evening";
  }
  return "night";
}

/** Map a period name to its representative start hour for bucketing. */
export function periodToStartHour(period: TimePeriod): number {
  switch (period) {
    case "morning":
      return 6;
    case "afternoon":
      return 12;
    case "evening":
      return 18;
    case "night":
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isReplyOutcome(o: OutcomeRecord): boolean {
  return o.outcomeType === "user_replied" || o.outcomeType === "explicit_positive";
}

function emptyAggregates(): AggregateStats {
  return {
    computedAt: new Date().toISOString(),
    totalActions: 0,
    totalOutcomes: 0,
    byActionType: {},
    byHourOfDay: {},
    byConsecutiveIgnores: {},
    byChannel: {},
  };
}

// ---------------------------------------------------------------------------
// AggregateComputer
// ---------------------------------------------------------------------------

export class AggregateComputer {
  private aggregates: AggregateStats = emptyAggregates();

  /**
   * Full recompute: reads all actions and outcomes from storage, computes
   * fresh aggregate stats, writes results back to disk.
   * Never throws — returns empty aggregates on failure.
   */
  async recomputeAggregates(
    storageDir: string,
    options?: { agentId?: string },
  ): Promise<AggregateStats[]> {
    try {
      const opts = { agentId: options?.agentId, home: storageDir };

      // Read all records — full correlation requires both sets in memory.
      // Uses streaming I/O to avoid loading the entire file string at once,
      // but records are collected since computeFromRecords needs random access.
      const actions: ActionRecord[] = [];
      for await (const action of streamActions(opts)) {
        actions.push(action);
      }
      const outcomes: OutcomeRecord[] = [];
      for await (const outcome of streamOutcomes(opts)) {
        outcomes.push(outcome);
      }

      const stats = computeFromRecords(actions, outcomes);
      this.aggregates = stats;

      await writeAggregates(stats, opts);
      return [stats];
    } catch (err: unknown) {
      log.warn("Failed to recompute aggregates", { error: String(err) });
      return [emptyAggregates()];
    }
  }

  /**
   * Incremental update: adjust cached aggregates with a single new action
   * and optional outcome without re-reading all logs.
   * Never throws.
   */
  /**
   * Incremental update: adjust cached aggregates with a new outcome for an
   * existing action. Only updates outcome-related stats (reply rate, outcome
   * count) — action counts are NOT incremented since the action was already
   * counted when it was first logged.
   */
  updateAggregatesIncremental(action: ActionRecord, outcome: OutcomeRecord): void {
    try {
      const stats = this.aggregates;
      stats.computedAt = new Date().toISOString();
      stats.totalOutcomes += 1;

      const at = action.actionType;
      const existing = stats.byActionType[at];
      if (existing) {
        existing.outcomeCount += 1;
        const replied = isReplyOutcome(outcome);
        const prevReplies = existing.replyRate * (existing.outcomeCount - 1);
        existing.replyRate = (prevReplies + (replied ? 1 : 0)) / existing.outcomeCount;

        // Update hour reply rate
        const hour = new Date(action.timestamp).getUTCHours();
        const hourEntry = stats.byHourOfDay[hour];
        if (hourEntry && hourEntry.count > 0) {
          const prevHourReplies = hourEntry.replyRate * (hourEntry.count - 1);
          hourEntry.replyRate = (prevHourReplies + (replied ? 1 : 0)) / hourEntry.count;
        }

        // Update channel reply rate
        const channelEntry = stats.byChannel[action.channelId];
        if (channelEntry && channelEntry.count > 0) {
          const prevChReplies = channelEntry.replyRate * (channelEntry.count - 1);
          channelEntry.replyRate = (prevChReplies + (replied ? 1 : 0)) / channelEntry.count;
        }
      }
    } catch (err: unknown) {
      log.warn("Failed incremental aggregate update", { error: String(err) });
    }
  }

  /**
   * Get current cached aggregates, optionally filtered by action type.
   * Never throws.
   */
  async getAggregates(actionType?: string): Promise<AggregateStats[]> {
    try {
      if (actionType) {
        // Return a filtered copy containing only the requested action type
        const filtered: AggregateStats = {
          ...this.aggregates,
          byActionType: {},
        };
        const key = actionType as ActionType;
        if (this.aggregates.byActionType[key]) {
          filtered.byActionType[key] = this.aggregates.byActionType[key];
        }
        return [filtered];
      }
      return [this.aggregates];
    } catch (err: unknown) {
      log.warn("Failed to get aggregates", { error: String(err) });
      return [emptyAggregates()];
    }
  }

  /**
   * Load previously persisted aggregates from disk into memory.
   * Never throws.
   */
  async loadFromDisk(storageDir: string, options?: { agentId?: string }): Promise<void> {
    try {
      const stored = await readAggregates({
        agentId: options?.agentId,
        home: storageDir,
      });
      if (stored) {
        this.aggregates = stored;
      }
    } catch (err: unknown) {
      log.warn("Failed to load aggregates from disk", { error: String(err) });
    }
  }
}

// ---------------------------------------------------------------------------
// Pure computation from records
// ---------------------------------------------------------------------------

/**
 * Compute aggregate stats from a set of action and outcome records.
 * Pure function (no I/O).
 */
export function computeFromRecords(
  actions: ActionRecord[],
  outcomes: OutcomeRecord[],
): AggregateStats {
  const stats = emptyAggregates();
  stats.totalActions = actions.length;
  stats.totalOutcomes = outcomes.length;

  // Index outcomes by actionId for fast lookup
  const outcomesByAction = new Map<string, OutcomeRecord[]>();
  for (const o of outcomes) {
    const existing = outcomesByAction.get(o.actionId);
    if (existing) {
      existing.push(o);
    } else {
      outcomesByAction.set(o.actionId, [o]);
    }
  }

  // Per-action-type accumulators
  const typeAccum = new Map<
    ActionType,
    { count: number; outcomeCount: number; replyCount: number; suppressedCount: number }
  >();

  // Per-hour accumulators
  const hourAccum = new Map<number, { count: number; replyCount: number }>();

  // Per-channel accumulators
  const channelAccum = new Map<string, { count: number; replyCount: number }>();

  // Fatigue (consecutive-ignores) — simplified: track per-session sequences
  const consecutiveIgnoresAccum = new Map<number, { count: number; replyCount: number }>();

  // Track consecutive ignores per session
  const sessionIgnoreCount = new Map<string, number>();

  for (const action of actions) {
    const at = action.actionType;
    const acc = typeAccum.get(at) ?? {
      count: 0,
      outcomeCount: 0,
      replyCount: 0,
      suppressedCount: 0,
    };
    acc.count += 1;
    if (action.actionType === "suppressed") {
      acc.suppressedCount += 1;
    }

    // Check outcomes for this action
    const actionOutcomes = outcomesByAction.get(action.id) ?? [];
    acc.outcomeCount += actionOutcomes.length;
    const gotReply = actionOutcomes.some(isReplyOutcome);
    if (gotReply) {
      acc.replyCount += 1;
    }

    typeAccum.set(at, acc);

    // Hour-of-day
    const hour = new Date(action.timestamp).getUTCHours();
    const ha = hourAccum.get(hour) ?? { count: 0, replyCount: 0 };
    ha.count += 1;
    if (gotReply) {
      ha.replyCount += 1;
    }
    hourAccum.set(hour, ha);

    // Channel
    const ca = channelAccum.get(action.channelId) ?? { count: 0, replyCount: 0 };
    ca.count += 1;
    if (gotReply) {
      ca.replyCount += 1;
    }
    channelAccum.set(action.channelId, ca);

    // Consecutive ignores tracking
    const sessionKey = action.sessionKey;
    const currentIgnores = sessionIgnoreCount.get(sessionKey) ?? 0;
    const fa = consecutiveIgnoresAccum.get(currentIgnores) ?? { count: 0, replyCount: 0 };
    fa.count += 1;
    if (gotReply) {
      fa.replyCount += 1;
      sessionIgnoreCount.set(sessionKey, 0);
    } else {
      sessionIgnoreCount.set(sessionKey, currentIgnores + 1);
    }
    consecutiveIgnoresAccum.set(currentIgnores, fa);
  }

  // Materialize per-action-type stats
  for (const [at, acc] of typeAccum) {
    stats.byActionType[at] = {
      count: acc.count,
      outcomeCount: acc.outcomeCount,
      replyRate: acc.count > 0 ? acc.replyCount / acc.count : 0,
      suppressionRate: acc.count > 0 ? acc.suppressedCount / acc.count : 0,
    };
  }

  // Materialize per-hour stats
  for (const [hour, acc] of hourAccum) {
    stats.byHourOfDay[hour] = {
      count: acc.count,
      replyRate: acc.count > 0 ? acc.replyCount / acc.count : 0,
    };
  }

  // Materialize per-channel stats
  for (const [ch, acc] of channelAccum) {
    stats.byChannel[ch] = {
      count: acc.count,
      replyRate: acc.count > 0 ? acc.replyCount / acc.count : 0,
    };
  }

  // Materialize fatigue correlation
  for (const [ignores, acc] of consecutiveIgnoresAccum) {
    stats.byConsecutiveIgnores[ignores] = {
      count: acc.count,
      replyRate: acc.count > 0 ? acc.replyCount / acc.count : 0,
    };
  }

  return stats;
}
