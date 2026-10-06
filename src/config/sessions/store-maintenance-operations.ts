// Storage-neutral session maintenance operations for the file-backed session store.
import path from "node:path";
import { enforceSessionDiskBudget } from "./disk-budget.js";
import { planSessionEntryMaintenance } from "./store-maintenance-plan.js";
import { collectSessionMaintenancePreserveKeysForStore } from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import {
  countUnarchivedSessionEntries,
  normalizeResolvedMaintenanceConfigInput,
  type ResolvedSessionMaintenanceConfig,
  type ResolvedSessionMaintenanceConfigInput,
} from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

type RemovedSessionFiles = Map<string, string | undefined>;

type RemovedSessionArtifactCleanup = {
  archiveRemovedSessionTranscripts: (params: {
    removedSessionFiles: Iterable<[string, string | undefined]>;
    referencedSessionIds: ReadonlySet<string>;
    storePath: string;
    reason: "deleted";
    restrictToStoreDir: true;
  }) => Promise<Set<string>>;
  cleanupArchivedSessionTranscripts: (params: {
    directories: string[];
    rules: Array<{ reason: "deleted" | "reset"; olderThanMs: number }>;
  }) => Promise<void>;
};

type FileBackedSessionStoreMaintenanceParams = {
  storePath: string;
  store: Record<string, SessionEntry>;
  maintenanceConfig?: ResolvedSessionMaintenanceConfigInput;
  log: NonNullable<Parameters<typeof enforceSessionDiskBudget>[0]["log"]>;
  artifacts: RemovedSessionArtifactCleanup;
  commitReducedStore?: () => Promise<void>;
};

function collectReferencedSessionIds(store: Record<string, SessionEntry>): Set<string> {
  return new Set(
    Object.values(store)
      .map((entry) => entry?.sessionId)
      .filter((id): id is string => Boolean(id)),
  );
}

async function cleanupRemovedSessionArtifacts(params: {
  operation: FileBackedSessionStoreMaintenanceParams;
  maintenance: ResolvedSessionMaintenanceConfig;
  removedSessionFiles: RemovedSessionFiles;
  referencedSessionIds: ReadonlySet<string>;
}): Promise<void> {
  // SQLite should commit entry-retention rows before this named artifact cleanup.
  // The cleanup needs the final referenced-session set so shared transcripts
  // survive until the last referring row is gone.
  const archivedDirs = await params.operation.artifacts.archiveRemovedSessionTranscripts({
    removedSessionFiles: params.removedSessionFiles,
    referencedSessionIds: params.referencedSessionIds,
    storePath: params.operation.storePath,
    reason: "deleted",
    restrictToStoreDir: true,
  });
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
): Promise<void> {
  const maintenance = params.maintenanceConfig
    ? normalizeResolvedMaintenanceConfigInput(params.maintenanceConfig)
    : resolveMaintenanceConfig();
  const preserveSessionKeys = await collectSessionMaintenancePreserveKeysForStore({
    storePath: params.storePath,
    store: params.store,
  });

  const warnOnly = maintenance.mode === "warn";
  if (!warnOnly) {
    const removedSessionFiles = new Map<string, string | undefined>();
    planSessionEntryMaintenance({
      maintenance,
      initialUnarchivedCount: countUnarchivedSessionEntries(params.store),
      readPreserveKeys: () => preserveSessionKeys,
      readAgeCandidates: () => params.store,
      readCapCandidates: () => ({ store: params.store, maxEntries: maintenance.maxEntries }),
      onRemoved: ({ entry }) => {
        removedSessionFiles.set(entry.sessionId, undefined);
      },
    });
    await cleanupRemovedSessionArtifacts({
      operation: params,
      maintenance,
      removedSessionFiles,
      referencedSessionIds: collectReferencedSessionIds(params.store),
    });
  }

  // Disk eviction follows settled prune/cap artifact cleanup and retains its own commit boundary.
  await enforceSessionDiskBudget({
    store: params.store,
    storePath: params.storePath,
    maintenance,
    warnOnly,
    log: params.log,
    ...(!warnOnly
      ? { preserveKeys: preserveSessionKeys, commitEvictedIndex: params.commitReducedStore }
      : {}),
  });
}
