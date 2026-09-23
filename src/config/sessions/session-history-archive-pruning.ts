import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { hasErrnoCode } from "../../infra/errno.js";
import type {
  SqliteWalCheckpointSnapshot,
  SqliteWalHealth,
} from "../../infra/sqlite-wal-checkpoint.js";
import type { SqliteWalReclamationResult } from "../../infra/sqlite-wal-reclamation.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db.js";
import {
  measureSessionPhysicalDiskUsage,
  pruneSessionTranscriptArchivesToHighWater,
  type SessionPhysicalDiskUsage,
} from "./disk-budget.js";
import type { SqliteSessionArchivePruningDiagnostics } from "./session-accessor.sqlite-contract.js";
import {
  readSqliteSessionArchivePruning,
  withSqliteSessionPageReclamation,
} from "./session-accessor.sqlite-page-reclamation.js";
import { runExclusiveSqliteSessionWrite } from "./session-accessor.sqlite-scope.js";
import {
  observeSessionArchivePruning,
  timeArchivePruningAsync,
} from "./session-history-archive-pruning-diagnostics.js";
import type { SessionArchivePruningOperations } from "./session-history-archive-pruning.types.js";

type PageReclamation = {
  reclaimPages?: (maxPages?: number) => Promise<SqliteWalReclamationResult>;
  onCheckpointIncomplete?: (checkpoint: SqliteWalCheckpointSnapshot | undefined) => void;
  assertCurrent?: () => void;
};

type ArchivePruningParams = Pick<PageReclamation, "onCheckpointIncomplete"> & {
  archiveDirectory: string;
  databaseOptions: OpenClawAgentDatabaseOptions;
  diagnostics?: SqliteSessionArchivePruningDiagnostics;
  highWaterBytes: number;
  storePath: string;
};

type OwnedArchivePruningParams = ArchivePruningParams & {
  reclaimPages: NonNullable<PageReclamation["reclaimPages"]>;
  assertCurrent: () => void;
  archives: SessionArchivePruningOperations;
};

function withArchivePruningWriter<T>(
  params: OwnedArchivePruningParams,
  run: () => Promise<T>,
): Promise<T> {
  return runExclusiveSqliteSessionWrite(
    params.databaseOptions,
    async () => {
      params.assertCurrent();
      return run();
    },
    "session.history.archive-prune",
  );
}

export type SessionArchivePruningResult = {
  removedFiles: number;
  usage: SessionPhysicalDiskUsage;
  completed: boolean;
  checkpointIncomplete: number;
  checkpoint?: SqliteWalHealth;
};

export async function reclaimSqliteFreePages(
  databaseOptions: OpenClawAgentDatabaseOptions,
  diagnostics?: SqliteSessionArchivePruningDiagnostics,
  limits?: PageReclamation & { maxPasses?: number; maxPages?: number },
): Promise<boolean> {
  const reclaimPages = limits?.reclaimPages;
  if (!reclaimPages) {
    return withSqliteSessionPageReclamation(
      databaseOptions,
      (reclaimPages, assertCurrent, preparedOptions) =>
        reclaimSqliteFreePages(preparedOptions, diagnostics, {
          ...limits,
          reclaimPages,
          assertCurrent: () => {
            limits?.assertCurrent?.();
            assertCurrent();
          },
        }),
    );
  }
  let remaining = limits?.maxPages;
  const maxPasses = limits?.maxPasses ?? Infinity;
  for (let pass = 0; pass < maxPasses && (remaining === undefined || remaining > 0); pass++) {
    if (pass > 0) {
      await setImmediate();
    }
    limits?.assertCurrent?.();
    const result = await reclaimPages(remaining);
    if (diagnostics) {
      for (const key of [
        "checkpointCalls",
        "checkpointIncomplete",
        "checkpointMs",
        "queryMs",
        "vacuumMs",
        "vacuumPasses",
        "vacuumPagesRequested",
      ] as const) {
        diagnostics[key] = (diagnostics[key] ?? 0) + result[key];
      }
      diagnostics.checkpointMaxMs = Math.max(
        diagnostics.checkpointMaxMs ?? 0,
        result.checkpointMaxMs,
      );
      diagnostics.checkpoint = result.checkpoint?.health;
    }
    if (!result.checkpointCompleted) {
      limits?.onCheckpointIncomplete?.(result.checkpoint);
      return false;
    }
    const before = result.freePagesBefore;
    const after = result.remainingFreePages;
    if (before === null || after === null || before <= 0 || after >= before) {
      return true;
    }
    remaining = Math.min(remaining ?? before, before) - (before - after);
  }
  return true;
}

export async function hasCanonicalSessionTranscriptArchives(
  databaseOptions: OpenClawAgentDatabaseOptions,
): Promise<boolean> {
  return (await readSqliteSessionArchivePruning(databaseOptions)) !== null;
}

async function pruneCanonicalSessionTranscriptArchivesToHighWater(
  params: OwnedArchivePruningParams,
): Promise<{ removedFiles: number; usage: SessionPhysicalDiskUsage }> {
  const { diagnostics } = params;
  const measure = () =>
    timeArchivePruningAsync(diagnostics, "measurementMs", () =>
      measureSessionPhysicalDiskUsage(params.storePath),
    );
  let usage = await measure();
  let removedFiles = 0;
  while (usage.totalBytes > params.highWaterBytes) {
    const removed = await withArchivePruningWriter(params, async () => {
      // A foreground writer may have freed space while this item waited for admission.
      usage = await measure();
      params.assertCurrent();
      if (usage.totalBytes <= params.highWaterBytes) {
        return false;
      }
      const row = await timeArchivePruningAsync(diagnostics, "queryMs", () =>
        params.archives.read(),
      );
      params.assertCurrent();
      if (!row) {
        return false;
      }
      const archivePath = path.resolve(params.archiveDirectory, row.archive_name);
      if (
        path.dirname(archivePath) !== path.resolve(params.archiveDirectory) ||
        path.basename(archivePath) !== row.archive_name
      ) {
        throw new Error(`Invalid canonical session archive name for ${row.session_id}`);
      }
      params.assertCurrent();
      try {
        await timeArchivePruningAsync(diagnostics, "fileRemovalMs", () =>
          fs.promises.rm(archivePath),
        );
        removedFiles += 1;
        if (diagnostics) {
          diagnostics.removedFiles = (diagnostics.removedFiles ?? 0) + 1;
        }
      } catch (error) {
        // Keep the canonical recovery copy if its derived file could not be removed.
        if (!hasErrnoCode(error, "ENOENT")) {
          if (diagnostics) {
            diagnostics.failedRemovals = (diagnostics.failedRemovals ?? 0) + 1;
          }
          return false;
        }
        if (diagnostics) {
          diagnostics.missingFiles = (diagnostics.missingFiles ?? 0) + 1;
        }
      }
      await timeArchivePruningAsync(diagnostics, "rowDeletionMs", () =>
        params.archives.deletePublished(row),
      );
      return true;
    });
    if (!removed) {
      break;
    }
    // Each page unit owns separate FIFO admission after this item's writer settles.
    const checkpointCompleted = await reclaimSqliteFreePages(
      params.databaseOptions,
      diagnostics,
      params,
    );
    usage = await measure();
    if (!checkpointCompleted) {
      break;
    }
  }
  return { removedFiles, usage };
}

export function pruneAllSessionTranscriptArchivesToHighWater(
  input: ArchivePruningParams,
): Promise<SessionArchivePruningResult> {
  const diagnostics = input.diagnostics ?? { trigger: "initial" };
  return observeSessionArchivePruning(diagnostics, () =>
    withSqliteSessionPageReclamation(
      input.databaseOptions,
      (reclaimPages, assertCurrent, databaseOptions, archives) =>
        pruneSessionArchivesWithOwner({
          ...input,
          diagnostics,
          reclaimPages,
          assertCurrent,
          databaseOptions,
          archives,
        }),
    ),
  );
}

async function pruneSessionArchivesWithOwner(
  params: OwnedArchivePruningParams & { diagnostics: SqliteSessionArchivePruningDiagnostics },
): Promise<SessionArchivePruningResult> {
  const { diagnostics } = params;
  const measure = () =>
    timeArchivePruningAsync(diagnostics, "measurementMs", () =>
      measureSessionPhysicalDiskUsage(params.storePath),
    );
  const before = await measure();
  diagnostics.totalBytesBefore = before.totalBytes;
  diagnostics.walBytesBefore = before.databaseWalBytes;
  const finish = (result: {
    removedFiles: number;
    usage: SessionPhysicalDiskUsage;
  }): SessionArchivePruningResult => {
    params.assertCurrent();
    diagnostics.totalBytesAfter = result.usage.totalBytes;
    diagnostics.walBytesAfter = result.usage.databaseWalBytes;
    const checkpointIncomplete = diagnostics.checkpointIncomplete ?? 0;
    diagnostics.completed = checkpointIncomplete === 0 && !diagnostics.failedRemovals;
    return {
      ...result,
      completed: diagnostics.completed,
      checkpointIncomplete,
      checkpoint: diagnostics.checkpoint,
    };
  };
  // Unreclaimable WAL pressure must not destroy archives or create more WAL frames.
  if (!(await reclaimSqliteFreePages(params.databaseOptions, diagnostics, params))) {
    return finish({ removedFiles: 0, usage: await measure() });
  }
  const canonical = await pruneCanonicalSessionTranscriptArchivesToHighWater(params);
  if (diagnostics.checkpointIncomplete || canonical.usage.totalBytes <= params.highWaterBytes) {
    return finish(canonical);
  }
  const legacy = await pruneSessionTranscriptArchivesToHighWater({
    diagnostics,
    highWaterBytes: params.highWaterBytes,
    storePath: params.storePath,
    removeFile: (file) =>
      withArchivePruningWriter(params, async () => {
        const usage = await measure();
        params.assertCurrent();
        if (usage.totalBytes <= params.highWaterBytes) {
          return "preserved";
        }
        return timeArchivePruningAsync(diagnostics, "fileRemovalMs", () =>
          params.archives.removeLegacy(file.path),
        );
      }),
  });
  return finish({
    removedFiles: canonical.removedFiles + legacy.removedFiles,
    usage: legacy.usage,
  });
}
