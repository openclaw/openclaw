import { sqliteReaderDatabasePathKey } from "../../infra/sqlite-reader-lifecycle.js";
import { onSqliteWalCheckpoint, type SqliteWalHealth } from "../../infra/sqlite-wal-checkpoint.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { SessionDiskBudgetSweepResult } from "./disk-budget.types.js";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";

const log = createSubsystemLogger("sessions/history-eviction");

export type SessionHistoryDiskBudgetParams = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  mode: ResolvedSessionMaintenanceConfig["mode"];
  reclamationMode?: "worker" | "in-process";
  storePath: string;
  maintenance: Pick<ResolvedSessionMaintenanceConfig, "highWaterBytes" | "maxDiskBytes"> &
    Partial<Pick<ResolvedSessionMaintenanceConfig, "preserveRecentMs">>;
};

export function createPhysicalBudgetResult(params: {
  totalBytesBefore: number;
  totalBytesAfter?: number;
  removedEntries?: number;
  removedFiles?: number;
  maxBytes: number;
  highWaterBytes: number;
  deferred?: { checkpoint?: SqliteWalHealth; walBytesBefore: number; walBytesAfter: number };
}): SessionDiskBudgetSweepResult {
  const totalBytesAfter = params.totalBytesAfter ?? params.totalBytesBefore;
  return {
    totalBytesBefore: params.totalBytesBefore,
    totalBytesAfter,
    removedFiles: params.removedFiles ?? 0,
    removedEntries: params.removedEntries ?? 0,
    freedBytes: Math.max(0, params.totalBytesBefore - totalBytesAfter),
    maxBytes: params.maxBytes,
    highWaterBytes: params.highWaterBytes,
    overBudget: params.totalBytesBefore > params.maxBytes,
    ...(params.deferred
      ? {
          deferredReason: "checkpoint-incomplete" as const,
          ...params.deferred,
        }
      : {}),
  };
}

export const PHYSICAL_BUDGET_CHECK_INTERVAL_MS = 30 * 60 * 1000;
export const FORCED_PHYSICAL_BUDGET_CHECK_INTERVAL_MS = 60 * 1000;
// Single-slot per store: ordinary entry writes kick a throttled background
// budget pass so an over-budget database self-heals without waiting for a
// manual `sessions cleanup` invocation.
export type SessionHistoryBudgetKick = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  storePath: string;
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
  now?: number;
  /** Use the shorter post-delete interval; freshly written archives can double usage. */
  force?: boolean;
};

type BudgetKickState = {
  budget: SessionHistoryDiskBudgetParams["maintenance"];
  lastCheckAt: number;
  lastForcedCheckAt: number;
  running: boolean;
  pendingForce?: SessionHistoryBudgetKick;
  blockedUntil?: number;
  checkpointBlocked?: { databasePath: string; checkpoint?: SqliteWalHealth; warned?: boolean };
};

export const budgetKickStateByStore = new Map<string, BudgetKickState>();

onSqliteWalCheckpoint(({ databasePath, health }) => {
  if (health.state !== "complete") {
    return;
  }
  for (const state of budgetKickStateByStore.values()) {
    // Worker messages can arrive after a newer parent-side observation.
    if (
      state.checkpointBlocked?.databasePath === databasePath &&
      health.observedAtMs >= (state.checkpointBlocked.checkpoint?.observedAtMs ?? -Infinity)
    ) {
      state.checkpointBlocked = undefined;
      state.blockedUntil = undefined;
      state.lastCheckAt = -Infinity;
      state.lastForcedCheckAt = -Infinity;
    }
  }
});

export function deferPhysicalBudgetForCheckpoint(
  params: SessionHistoryDiskBudgetParams,
  databasePath: string,
  checkpoint: SqliteWalHealth | undefined,
): void {
  const state = getBudgetKickState(params.storePath, params.maintenance);
  state.checkpointBlocked = { databasePath: sqliteReaderDatabasePathKey(databasePath), checkpoint };
}

export function getBudgetKickState(
  storePath: string,
  budget: SessionHistoryDiskBudgetParams["maintenance"],
): BudgetKickState {
  let state = budgetKickStateByStore.get(storePath);
  if (!state) {
    state = { budget, lastCheckAt: -Infinity, lastForcedCheckAt: -Infinity, running: false };
    budgetKickStateByStore.set(storePath, state);
  } else if (
    state.budget.maxDiskBytes !== budget.maxDiskBytes ||
    state.budget.highWaterBytes !== budget.highWaterBytes ||
    state.budget.preserveRecentMs !== budget.preserveRecentMs
  ) {
    // Operator budget/protection changes should take effect on the next kick.
    state.budget = budget;
    state.lastCheckAt = -Infinity;
    state.lastForcedCheckAt = -Infinity;
    state.blockedUntil = undefined;
  }
  return state;
}

export function recordPhysicalBudgetOutcome(
  params: SessionHistoryDiskBudgetParams,
  result: SessionDiskBudgetSweepResult | null,
): void {
  if (params.mode !== "enforce" || !result) {
    return;
  }
  const state = getBudgetKickState(params.storePath, params.maintenance);
  if (result.deferredReason) {
    if (state.checkpointBlocked?.warned) {
      return;
    }
    if (state.checkpointBlocked) {
      state.checkpointBlocked.warned = true;
    }
    log.warn("session history disk budget deferred until a completed WAL checkpoint is observed", {
      storePath: params.storePath,
      reason: result.deferredReason,
      totalBytesBefore: result.totalBytesBefore,
      totalBytesAfter: result.totalBytesAfter,
      walBytesBefore: result.walBytesBefore,
      walBytesAfter: result.walBytesAfter,
      checkpoint: result.checkpoint,
    });
    return;
  }
  if (result.totalBytesAfter <= result.maxBytes) {
    state.blockedUntil = undefined;
    return;
  }
  const alreadyBlocked = state.blockedUntil !== undefined;
  state.blockedUntil = Date.now() + PHYSICAL_BUDGET_CHECK_INTERVAL_MS;
  if (!alreadyBlocked) {
    log.warn(
      "session history disk budget remains exceeded after cleanup; retained data is protected or could not be reclaimed. Raise session.maintenance.maxDiskBytes or export and delete unneeded sessions; automatic checks resume on activity after 30 minutes",
      {
        storePath: params.storePath,
        totalBytes: result.totalBytesAfter,
        maxBytes: result.maxBytes,
        highWaterBytes: result.highWaterBytes,
        nextCheckAt: state.blockedUntil,
      },
    );
  }
}
