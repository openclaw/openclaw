import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import {
  measureSessionPhysicalDiskUsage,
  pruneSessionTranscriptArchivesToHighWater,
  type SessionPhysicalDiskUsage,
} from "./disk-budget.js";
import type {
  SqliteSessionArchivePruningDiagnostics,
  SqliteSessionDatabaseAdmissionDiagnostics,
} from "./session-accessor.sqlite-contract.js";
import { getSessionKysely, withSqliteSessionDatabase } from "./session-accessor.sqlite-scope.js";
import {
  timeArchivePruningAsync,
  timeArchivePruningSync,
} from "./session-history-archive-pruning-diagnostics.js";

async function withArchivePruningDatabase<T>(
  options: OpenClawAgentDatabaseOptions,
  diagnostics: SqliteSessionArchivePruningDiagnostics | undefined,
  operation: (database: OpenClawAgentDatabase) => T,
): Promise<T> {
  const admission: SqliteSessionDatabaseAdmissionDiagnostics | undefined = diagnostics
    ? {}
    : undefined;
  try {
    return await withSqliteSessionDatabase(options, operation, undefined, admission);
  } finally {
    if (diagnostics && admission?.admissionMs !== undefined) {
      diagnostics.admissionMs = (diagnostics.admissionMs ?? 0) + admission.admissionMs;
      if (admission.admissionMode === "cached") {
        diagnostics.cachedAdmissions = (diagnostics.cachedAdmissions ?? 0) + 1;
      } else if (admission.admissionMode === "async") {
        diagnostics.asyncAdmissions = (diagnostics.asyncAdmissions ?? 0) + 1;
      }
    }
  }
}

function checkpointArchivePruning(
  database: OpenClawAgentDatabase,
  diagnostics: SqliteSessionArchivePruningDiagnostics | undefined,
): void {
  if (!diagnostics) {
    database.walMaintenance.checkpoint();
    return;
  }
  diagnostics.checkpointCalls = (diagnostics.checkpointCalls ?? 0) + 1;
  const startedAt = performance.now();
  try {
    const completed = database.walMaintenance.checkpoint();
    diagnostics.checkpointIncomplete = (diagnostics.checkpointIncomplete ?? 0) + Number(!completed);
  } finally {
    const elapsedMs = performance.now() - startedAt;
    diagnostics.checkpointMs = (diagnostics.checkpointMs ?? 0) + elapsedMs;
    diagnostics.checkpointMaxMs = Math.max(diagnostics.checkpointMaxMs ?? 0, elapsedMs);
  }
}

export async function reclaimSqliteFreePages(
  databaseOptions: OpenClawAgentDatabaseOptions,
  diagnostics?: SqliteSessionArchivePruningDiagnostics,
): Promise<void> {
  let remaining: number | undefined;
  while (remaining === undefined || remaining > 0) {
    if (remaining !== undefined) {
      await setImmediate();
    }
    // Reacquire after yielding while the caller retains its writer section.
    const nextRemaining = await withArchivePruningDatabase(
      databaseOptions,
      diagnostics,
      (database) => {
        checkpointArchivePruning(database, diagnostics);
        // sqlite-allow-raw -- Physical budget decisions need current SQLite page accounting.
        const freePages = () =>
          timeArchivePruningSync(diagnostics, "queryMs", () =>
            Number(database.db.prepare("PRAGMA freelist_count").get()?.freelist_count ?? 0),
          );
        const before = freePages();
        if (!Number.isSafeInteger(before) || before <= 0) {
          return undefined;
        }
        // Bound the entire drain to its initial freelist, even if other writers free more pages.
        const passRemaining = Math.min(remaining ?? before, before);
        const pages = Math.min(512, passRemaining);
        if (diagnostics) {
          diagnostics.vacuumPasses = (diagnostics.vacuumPasses ?? 0) + 1;
          diagnostics.vacuumPagesRequested = (diagnostics.vacuumPagesRequested ?? 0) + pages;
        }
        timeArchivePruningSync(diagnostics, "vacuumMs", () => {
          database.db.exec(`PRAGMA incremental_vacuum(${pages});`); // sqlite-allow-raw -- Bounded maintenance outside a transaction.
        });
        checkpointArchivePruning(database, diagnostics);
        if (freePages() >= before) {
          return undefined;
        }
        return passRemaining - pages;
      },
    );
    if (nextRemaining === undefined) {
      return;
    }
    remaining = nextRemaining;
  }
}

export function hasCanonicalSessionTranscriptArchives(
  databaseOptions: OpenClawAgentDatabaseOptions,
): boolean {
  // openclaw-agent-db.ts cache rule: LRU eviction closes idle handles across awaits.
  return hasCanonicalSessionTranscriptArchivesInDatabase(
    openOpenClawAgentDatabase(databaseOptions),
  );
}

function hasCanonicalSessionTranscriptArchivesInDatabase(database: OpenClawAgentDatabase): boolean {
  const db = getSessionKysely(database.db);
  const table = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("sqlite_schema")
      .select("name")
      .where("type", "=", "table")
      .where("name", "=", "session_transcript_archives"),
  ).rows[0];
  if (!table) {
    return false;
  }
  return (
    executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_transcript_archives")
        .select("session_id")
        .where("published_at", "is not", null)
        .limit(1),
    ).rows.length > 0
  );
}

function readUnpublishedSessionTranscriptArchiveNames(
  database: OpenClawAgentDatabase,
): Set<string> {
  const db = getSessionKysely(database.db);
  const table = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("sqlite_schema")
      .select("name")
      .where("type", "=", "table")
      .where("name", "=", "session_transcript_archives"),
  ).rows[0];
  if (!table) {
    return new Set();
  }
  return new Set(
    executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_transcript_archives")
        .select("archive_name")
        .where("published_at", "is", null),
    ).rows.map((row) => row.archive_name),
  );
}

async function pruneCanonicalSessionTranscriptArchivesToHighWater(params: {
  archiveDirectory: string;
  databaseOptions: OpenClawAgentDatabaseOptions;
  diagnostics?: SqliteSessionArchivePruningDiagnostics;
  highWaterBytes: number;
  storePath: string;
}): Promise<{ removedFiles: number; usage: SessionPhysicalDiskUsage }> {
  const { diagnostics } = params;
  let usage = await timeArchivePruningAsync(diagnostics, "measurementMs", () =>
    measureSessionPhysicalDiskUsage(params.storePath),
  );
  let removedFiles = 0;
  while (usage.totalBytes > params.highWaterBytes) {
    const row = await withArchivePruningDatabase(params.databaseOptions, diagnostics, (database) =>
      timeArchivePruningSync(diagnostics, "queryMs", () => {
        const db = getSessionKysely(database.db);
        return executeSqliteQuerySync(
          database.db,
          db
            .selectFrom("session_transcript_archives")
            .select(["archive_name", "generation", "session_id"])
            .where("published_at", "is not", null)
            .orderBy("created_at", "asc")
            .orderBy("session_id", "asc")
            .orderBy("generation", "asc")
            .limit(1),
        ).rows[0];
      }),
    );
    if (!row) {
      break;
    }
    const archivePath = path.resolve(params.archiveDirectory, row.archive_name);
    if (
      path.dirname(archivePath) !== path.resolve(params.archiveDirectory) ||
      path.basename(archivePath) !== row.archive_name
    ) {
      throw new Error(`Invalid canonical session archive name for ${row.session_id}`);
    }
    try {
      await timeArchivePruningAsync(diagnostics, "fileRemovalMs", () =>
        fs.promises.rm(archivePath),
      );
      removedFiles += 1;
      if (diagnostics) {
        diagnostics.removedFiles = (diagnostics.removedFiles ?? 0) + 1;
      }
    } catch (error) {
      // SAFETY: Node filesystem failures expose the documented errno code field.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // The database is the recovery copy. Retain it unless its derived file
        // is gone, otherwise retention could leave an undeletable orphan.
        if (diagnostics) {
          diagnostics.failedRemovals = (diagnostics.failedRemovals ?? 0) + 1;
        }
        break;
      }
      if (diagnostics) {
        diagnostics.missingFiles = (diagnostics.missingFiles ?? 0) + 1;
      }
    }
    await withArchivePruningDatabase(params.databaseOptions, diagnostics, () =>
      timeArchivePruningSync(diagnostics, "rowDeletionMs", () =>
        runOpenClawAgentWriteTransaction((transactionDb) => {
          const transactionKysely = getSessionKysely(transactionDb.db);
          executeSqliteQuerySync(
            transactionDb.db,
            transactionKysely
              .deleteFrom("session_transcript_archives")
              .where("session_id", "=", row.session_id)
              .where("generation", "=", row.generation),
          );
        }, params.databaseOptions),
      ),
    );
    await reclaimSqliteFreePages(params.databaseOptions, diagnostics);
    usage = await timeArchivePruningAsync(diagnostics, "measurementMs", () =>
      measureSessionPhysicalDiskUsage(params.storePath),
    );
  }
  return { removedFiles, usage };
}

export async function pruneAllSessionTranscriptArchivesToHighWater(params: {
  archiveDirectory: string;
  databaseOptions: OpenClawAgentDatabaseOptions;
  diagnostics?: SqliteSessionArchivePruningDiagnostics;
  highWaterBytes: number;
  storePath: string;
}): Promise<{ removedFiles: number; usage: SessionPhysicalDiskUsage }> {
  const { diagnostics } = params;
  // Reclaim committed free pages before pressure can destroy a retained archive.
  await reclaimSqliteFreePages(params.databaseOptions, diagnostics);
  const canonical = (await withArchivePruningDatabase(
    params.databaseOptions,
    diagnostics,
    (database) =>
      timeArchivePruningSync(diagnostics, "queryMs", () =>
        hasCanonicalSessionTranscriptArchivesInDatabase(database),
      ),
  ))
    ? await pruneCanonicalSessionTranscriptArchivesToHighWater(params)
    : {
        removedFiles: 0,
        usage: await timeArchivePruningAsync(diagnostics, "measurementMs", () =>
          measureSessionPhysicalDiskUsage(params.storePath),
        ),
      };
  if (canonical.usage.totalBytes <= params.highWaterBytes) {
    if (diagnostics) {
      diagnostics.completed = true;
    }
    return canonical;
  }
  const legacy = await pruneSessionTranscriptArchivesToHighWater({
    diagnostics,
    excludeNames: await withArchivePruningDatabase(
      params.databaseOptions,
      diagnostics,
      (database) =>
        timeArchivePruningSync(diagnostics, "queryMs", () =>
          readUnpublishedSessionTranscriptArchiveNames(database),
        ),
    ),
    highWaterBytes: params.highWaterBytes,
    storePath: params.storePath,
  });
  if (diagnostics) {
    diagnostics.completed = true;
  }
  return {
    removedFiles: canonical.removedFiles + legacy.removedFiles,
    usage: legacy.usage,
  };
}
