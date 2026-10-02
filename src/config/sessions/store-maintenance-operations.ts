// Storage-neutral session maintenance operations for the file-backed session store.
import path from "node:path";
import { enforceSessionDiskBudget } from "./disk-budget.js";
import type { SessionDiskBudgetSweepResult } from "./disk-budget.types.js";
import { planSessionEntryMaintenance } from "./store-maintenance-plan.js";
import { collectSessionMaintenancePreserveKeysForStore } from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import {
  countUnarchivedSessionEntries,
  getActiveSessionMaintenanceWarning,
  shouldRunSessionEntryMaintenance,
  normalizeResolvedMaintenanceConfigInput,
  type ResolvedSessionMaintenanceConfig,
  type ResolvedSessionMaintenanceConfigInput,
  type SessionMaintenanceWarning,
} from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

export type SessionMaintenanceApplyReport = {
  mode: ResolvedSessionMaintenanceConfig["mode"];
  beforeCount: number;
  afterCount: number;
  archived: number;
  capArchived: number;
  modelRunPruned: number;
  pruned: number;
  capped: number;
  diskBudget: SessionDiskBudgetSweepResult | null;
};

type SessionMaintenanceLogger = {
  warn: (message: string, context?: Record<string, unknown>) => void;
  info: (message: string, context?: Record<string, unknown>) => void;
};

type RemovedSessionFiles = Map<string, string | undefined>;

type RemovedSessionArtifactCleanup = {
  archiveRemovedSessionTranscripts: (params: {
    removedSessionFiles: Iterable<[string, string | undefined]>;
    referencedSessionIds: ReadonlySet<string>;
    storePath: string;
    reason: "deleted";
    restrictToStoreDir: true;
  }) => Promise<Set<string>>;
  removeRemovedSessionTrajectoryArtifacts: (params: {
    removedSessionFiles: RemovedSessionFiles;
    referencedSessionIds: ReadonlySet<string>;
    storePath: string;
    restrictToStoreDir: true;
  }) => Promise<void>;
  cleanupArchivedSessionTranscripts: (params: {
    directories: string[];
    rules: Array<{ reason: "deleted" | "reset"; olderThanMs: number }>;
  }) => Promise<void>;
};

type FileBackedSessionStoreMaintenanceParams = {
  storePath: string;
  store: Record<string, SessionEntry>;
  activeSessionKey?: string;
  onWarn?: (warning: SessionMaintenanceWarning) => void | Promise<void>;
  onMaintenanceApplied?: (report: SessionMaintenanceApplyReport) => void | Promise<void>;
  maintenanceOverride?: Partial<ResolvedSessionMaintenanceConfig>;
  maintenanceConfig?: ResolvedSessionMaintenanceConfigInput;
  log: SessionMaintenanceLogger;
  artifacts: RemovedSessionArtifactCleanup;
  commitReducedStore?: () => Promise<void>;
};

type FileBackedSessionStoreMaintenanceResult = {
  changedStore: boolean;
};

function collectReferencedSessionIds(store: Record<string, SessionEntry>): Set<string> {
  return new Set(
    Object.values(store)
      .map((entry) => entry?.sessionId)
      .filter((id): id is string => Boolean(id)),
  );
}

async function warnActiveSessionMaintenance(params: {
  operation: FileBackedSessionStoreMaintenanceParams;
  maintenance: ResolvedSessionMaintenanceConfig;
  shouldRunEntryMaintenance: boolean;
  preserveSessionKeys: ReadonlySet<string> | undefined;
}): Promise<void> {
  const activeSessionKey = params.operation.activeSessionKey?.trim();
  if (activeSessionKey && params.shouldRunEntryMaintenance) {
    const warning = getActiveSessionMaintenanceWarning({
      store: params.operation.store,
      activeSessionKey,
      pruneAfterMs: params.maintenance.pruneAfterMs,
      maxEntries: params.maintenance.maxEntries,
      preserveKeys: params.preserveSessionKeys,
      preserveRecentMs: params.maintenance.preserveRecentMs,
    });
    if (warning) {
      const outcome =
        warning.pruneOutcome === "remove" || warning.capOutcome === "remove" ? "remove" : "archive";
      params.operation.log.warn(
        `session maintenance would ${outcome} active session; skipping enforcement`,
        {
          activeSessionKey: warning.activeSessionKey,
          wouldPrune: warning.wouldPrune,
          wouldCap: warning.wouldCap,
          capOutcome: warning.capOutcome,
          pruneAfterMs: warning.pruneAfterMs,
          maxEntries: warning.maxEntries,
        },
      );
      await params.operation.onWarn?.(warning);
    }
  }
}

async function cleanupRemovedSessionArtifacts(params: {
  operation: FileBackedSessionStoreMaintenanceParams;
  maintenance: ResolvedSessionMaintenanceConfig;
  removedSessionFiles: RemovedSessionFiles;
  referencedSessionIds: ReadonlySet<string>;
}): Promise<void> {
  // SQLite should commit entry-retention rows before this named artifact cleanup.
  // The cleanup needs the final referenced-session set so shared transcripts and
  // trajectory sidecars survive until the last referring row is gone.
  const archivedDirs = await params.operation.artifacts.archiveRemovedSessionTranscripts({
    removedSessionFiles: params.removedSessionFiles,
    referencedSessionIds: params.referencedSessionIds,
    storePath: params.operation.storePath,
    reason: "deleted",
    restrictToStoreDir: true,
  });
  if (params.removedSessionFiles.size > 0) {
    await params.operation.artifacts.removeRemovedSessionTrajectoryArtifacts({
      removedSessionFiles: params.removedSessionFiles,
      referencedSessionIds: params.referencedSessionIds,
      storePath: params.operation.storePath,
      restrictToStoreDir: true,
    });
  }
  // null retention keeps archived transcripts: they are conversation history,
  // and the disk budget (not a wall-clock timer) is the only eviction path.
  if (params.maintenance.resetArchiveRetentionMs == null) {
    return;
  }
  const targetDirs =
    archivedDirs.size > 0
      ? [...archivedDirs]
      : [path.dirname(path.resolve(params.operation.storePath))];
  // Both reasons ride one advisory cleanup call: earlier artifact moves may
  // have committed, so retention failure must not block the primary store save.
  await params.operation.artifacts
    .cleanupArchivedSessionTranscripts({
      directories: targetDirs,
      rules: [
        { reason: "deleted", olderThanMs: params.maintenance.resetArchiveRetentionMs },
        { reason: "reset", olderThanMs: params.maintenance.resetArchiveRetentionMs },
      ],
    })
    .catch((error: unknown) => {
      params.operation.log.warn("session transcript archive retention cleanup failed", {
        error: String(error),
      });
    });
}

/**
 * Applies automatic session-store maintenance to the in-memory file-store image.
 *
 * Future SQLite adapters should map this into named boundaries: entry retention,
 * removed-session artifact cleanup, disk-budget eviction, and archive retention cleanup.
 */
export async function applyFileBackedSessionStoreMaintenance(
  params: FileBackedSessionStoreMaintenanceParams,
): Promise<FileBackedSessionStoreMaintenanceResult> {
  const maintenance = {
    ...(params.maintenanceConfig
      ? normalizeResolvedMaintenanceConfigInput(params.maintenanceConfig)
      : resolveMaintenanceConfig()),
    ...params.maintenanceOverride,
  };
  const beforeCount = Object.keys(params.store).length;
  const beforeUnarchivedCount = countUnarchivedSessionEntries(params.store);
  const forceMaintenance = params.maintenanceOverride !== undefined;
  const preserveSessionKeys = collectSessionMaintenancePreserveKeysForStore({
    storePath: params.storePath,
    store: params.store,
    baseKeys: [params.activeSessionKey],
  });
  const shouldRunEntryMaintenance = shouldRunSessionEntryMaintenance({
    entryCount: beforeUnarchivedCount,
    maxEntries: maintenance.maxEntries,
    force: forceMaintenance,
  });

  const warnOnly = maintenance.mode === "warn";
  let counts = { archived: 0, capArchived: 0, modelRunPruned: 0, pruned: 0, capped: 0 };
  if (warnOnly) {
    await warnActiveSessionMaintenance({
      operation: params,
      maintenance,
      shouldRunEntryMaintenance,
      preserveSessionKeys,
    });
  } else {
    const removedSessionFiles = new Map<string, string | undefined>();
    const { store: _store, ...appliedCounts } = planSessionEntryMaintenance({
      profile: "write",
      maintenance,
      initialUnarchivedCount: countUnarchivedSessionEntries(params.store),
      forceMaintenance,
      readPreserveKeys: () => preserveSessionKeys,
      readAgeCandidates: () => params.store,
      readCapCandidates: () => ({ store: params.store, maxEntries: maintenance.maxEntries }),
      onRemoved: ({ entry }) => {
        removedSessionFiles.set(entry.sessionId, undefined);
      },
    });
    counts = appliedCounts;
    await cleanupRemovedSessionArtifacts({
      operation: params,
      maintenance,
      removedSessionFiles,
      referencedSessionIds: collectReferencedSessionIds(params.store),
    });
  }

  // Disk eviction follows settled prune/cap artifact cleanup and retains its own commit boundary.
  const diskBudget = await enforceSessionDiskBudget({
    store: params.store,
    storePath: params.storePath,
    activeSessionKey: params.activeSessionKey,
    maintenance,
    warnOnly,
    log: params.log,
    ...(!warnOnly
      ? { preserveKeys: preserveSessionKeys, commitEvictedIndex: params.commitReducedStore }
      : {}),
  });
  await params.onMaintenanceApplied?.({
    mode: maintenance.mode,
    beforeCount,
    afterCount: Object.keys(params.store).length,
    ...counts,
    diskBudget,
  });
  return {
    changedStore:
      !warnOnly &&
      (counts.archived > 0 ||
        counts.modelRunPruned > 0 ||
        counts.pruned > 0 ||
        counts.capped > 0 ||
        (diskBudget?.removedEntries ?? 0) > 0),
  };
}
