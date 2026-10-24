import { sqliteReaderDatabasePathKey } from "../../infra/sqlite-reader-lifecycle.js";
import {
  onSqliteWalCheckpoint,
  type SqliteWalCheckpointSnapshot,
  type SqliteWalHealth,
} from "../../infra/sqlite-wal-checkpoint.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { SessionDiskBudgetSweepResult } from "./disk-budget.types.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "./session-sqlite-target-paths.js";
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
  walBytesAfter?: number;
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
    ...(params.walBytesAfter !== undefined ? { walBytesAfter: params.walBytesAfter } : {}),
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

export type SessionHistoryCheckpointGate = {
  databasePath: string;
  afterNs: bigint;
  completedAtNs: bigint;
};

type BudgetKickState = {
  budget: SessionHistoryDiskBudgetParams["maintenance"];
  lastCheckAt: number;
  lastForcedCheckAt: number;
  running: boolean;
  pendingForce?: SessionHistoryBudgetKick;
  blockedUntil?: number;
  protected?: boolean;
  checkpointGate?: SessionHistoryCheckpointGate;
  checkpointBlocked?: {
    checkpoint?: SqliteWalCheckpointSnapshot;
    warned?: boolean;
  };
};

const budgetKickStateByStore = new Map<string, BudgetKickState>();

/** Per-agent legacy and SQLite locators share one lane; custom stores can aggregate partitions. */
export function sessionHistoryBudgetStoreKey(storePath: string): string {
  const target = resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath);
  return sqliteReaderDatabasePathKey(target.agentId ? target.path : storePath);
}

onSqliteWalCheckpoint(({ databasePath, health, observedAtNs, lastCompletedAtNs }) => {
  const completedAtNs = health.state === "complete" ? observedAtNs : (lastCompletedAtNs ?? 0n);
  for (const state of budgetKickStateByStore.values()) {
    const gate = state.checkpointGate;
    if (!gate || gate.databasePath !== databasePath || completedAtNs <= gate.completedAtNs) {
      continue;
    }
    gate.completedAtNs = completedAtNs;
    if (state.checkpointBlocked && completedAtNs >= gate.afterNs) {
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
  checkpoint: SqliteWalCheckpointSnapshot | undefined,
): void {
  const state = getBudgetKickState(params.storePath, params.maintenance);
  state.protected = undefined;
  state.checkpointGate ??= {
    databasePath: sqliteReaderDatabasePathKey(databasePath),
    afterNs: checkpoint?.observedAtNs ?? process.hrtime.bigint(),
    completedAtNs: 0n,
  };
  state.checkpointBlocked = { checkpoint, warned: state.checkpointBlocked?.warned };
}

export function getBudgetKickState(
  storePath: string,
  budget: SessionHistoryDiskBudgetParams["maintenance"],
): BudgetKickState {
  const key = sessionHistoryBudgetStoreKey(storePath);
  let state = budgetKickStateByStore.get(key);
  if (!state) {
    state = { budget, lastCheckAt: -Infinity, lastForcedCheckAt: -Infinity, running: false };
    budgetKickStateByStore.set(key, state);
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
    state.protected = undefined;
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
    state.protected = undefined;
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
  state.checkpointGate = undefined;
  state.checkpointBlocked = undefined;
  if (result.totalBytesAfter <= result.maxBytes) {
    state.blockedUntil = undefined;
    state.protected = undefined;
    if (result.overBudget) {
      log.info("session history disk budget cleanup completed", {
        storePath: params.storePath,
        totalBytesBefore: result.totalBytesBefore,
        totalBytesAfter: result.totalBytesAfter,
        removedEntries: result.removedEntries,
        removedFiles: result.removedFiles,
        maxBytes: result.maxBytes,
      });
    }
    return;
  }
  const alreadyBlocked = state.blockedUntil !== undefined;
  state.blockedUntil = Date.now() + PHYSICAL_BUDGET_CHECK_INTERVAL_MS;
  state.protected =
    result.removedEntries === 0 && result.removedFiles === 0 && result.freedBytes === 0;
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
