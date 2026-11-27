import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { resolveStateDir } from "../config/paths.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { drainAgentDatabaseResources } from "../state/openclaw-agent-db-resources.js";
import { prepareOpenClawStateDatabaseRemoval } from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { resolveClientCredentialStorePath } from "./client-credential-paths.js";
import {
  getPublishFileExclusiveFailureDetails,
  publishFileExclusive,
  sha256File,
} from "./directory-durability.js";
import { formatDiskSpaceBytes, tryReadDiskSpace } from "./disk-space.js";
import { ignoreMissingPath } from "./errno.js";
import { formatErrorMessage } from "./errors.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { createSqliteLifecycleAggregateError } from "./sqlite-lifecycle-errors.js";
import {
  adoptPreparedLocation,
  releaseSnapshotTempDirectory,
} from "./sqlite-readonly-location-cleanup.js";
import { createSqliteSnapshotStagingDirectory } from "./sqlite-snapshot-staging.js";
import { prepareVerifiedSqliteFile } from "./sqlite-snapshot.js";
import { resolvePathJournalPolicy } from "./sqlite-wal-filesystem.js";
import { enableSqliteWalJournalMode } from "./sqlite-wal.js";
import {
  parseUpdateStateInspectionWorker,
  runUpdateStateInspectionWorker,
} from "./update-candidate-state.inspection.js";
import { readUpdateDatabaseGenerationsIsolated } from "./update-candidate-state.js";
import { readUpdateStateDatabaseSizes } from "./update-candidate-state.sizes.js";
import type { UpdateDatabaseBackup } from "./update-database-backup.js";
import type { UpdateDatabaseGenerations } from "./update-database-generations.js";
import { writeDisplacedDatabaseReceipts } from "./update-displaced-database-receipt.js";
import type { PluginCohortRecoveryBinding } from "./update-plugin-cohort-schema.js";

async function existingFile(file: string) {
  try {
    const info = await fs.lstat(file, { bigint: true });
    if (!info.isFile() || info.nlink !== 1n) {
      throw new Error(`Database recovery requires a regular, unaliased file: ${file}`);
    }
    return info;
  } catch (error) {
    return ignoreMissingPath(error);
  }
}

async function withDatabaseExclusion<T>(
  env: NodeJS.ProcessEnv,
  paths: string[],
  sourcePaths: string[],
  assertCurrent: () => void,
  operation: (assertOwned: () => void) => Promise<T>,
): Promise<T> {
  assertCurrent();
  const owner = await acquireGatewayLock({
    env,
    role: "sqlite-maintenance",
    allowInTests: true,
    timeoutMs: 0,
  });
  if (!owner) {
    throw new Error("Database rollback requires exclusive state ownership");
  }
  const exclusions: Array<Awaited<ReturnType<typeof prepareOpenClawStateDatabaseRemoval>>> = [];
  const assertOwned = () => {
    assertCurrent();
    owner.assertCurrent();
    for (const exclusion of exclusions) {
      exclusion.assertCurrent();
    }
  };
  // Process custody survives replacement; native exclusions and local seals
  // remain held until the complete database family, including the ledger, is restored.
  const drain = async (index: number): Promise<T> => {
    const pathname = sourcePaths[index];
    if (pathname === undefined) {
      for (const databasePath of paths) {
        exclusions.push(await prepareOpenClawStateDatabaseRemoval(databasePath, assertCurrent));
        assertOwned();
      }
      return operation(assertOwned);
    }
    // Local handles retain lexical ownership even when discovery canonicalizes a directory link.
    return drainAgentDatabaseResources({ path: pathname }, async () => {
      await closeOpenClawAgentDatabaseByPathAsync(pathname);
      assertOwned();
      return drain(index + 1);
    });
  };
  let outcome: { value: T } | { error: unknown };
  try {
    outcome = { value: await owner.run(() => drain(0)) };
  } catch (error) {
    outcome = { error };
  }
  // Unconfirmed child settlement retains native and local custody for recovery.
  if ("error" in outcome && hasCommandProcessCleanupError(outcome.error)) {
    throw outcome.error;
  }
  try {
    await owner.release();
    for (const exclusion of exclusions.toReversed()) {
      exclusion.release();
    }
  } catch (cleanupError) {
    if ("error" in outcome) {
      throw createSqliteLifecycleAggregateError(
        [outcome.error, cleanupError],
        "Database rollback and ownership cleanup both failed",
        outcome.error,
      );
    }
    throw cleanupError;
  }
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.value;
}

/**
 * Converts one restored database image back to the journal mode its path
 * resolves to. Snapshots are single DELETE-journal files by design; leaving a
 * restored database in rollback-journal mode makes the next update's
 * maintenance lease fail sqlite-busy against the updater's own readers and
 * rolls the same failure forward on every retry. The client credential store
 * is excluded by the caller: its exclusive custody design requires DELETE
 * mode. Throws so per-file failures stay collectable by the restore owner.
 */
async function reestablishRestoredDatabaseJournalMode(databasePath: string): Promise<void> {
  if (resolvePathJournalPolicy(databasePath) !== "wal") {
    return;
  }
  // The caller retains database exclusion; reuse native admission and the WAL
  // owner without starting long-lived checkpoint maintenance for this handle.
  const database = openNodeSqliteDatabase(databasePath);
  try {
    enableSqliteWalJournalMode(database, 0, { databasePath });
  } finally {
    database.close();
  }
}

/** The caller owns a settled failed candidate that has never admitted user work. */
export async function restoreUpdateDatabaseBackup(params: {
  backup: UpdateDatabaseBackup;
  runId: string;
  env: NodeJS.ProcessEnv;
  assertCurrent: () => void;
  expectedGenerations?: UpdateDatabaseGenerations;
  pluginCohortRecovery?: PluginCohortRecoveryBinding;
  /** Fires before the first live database changes; a failure before it left them untouched. */
  onLiveMutation?: () => void;
  /**
   * Receives recoverable journal-policy reconciliation failures after credential
   * rebinding completes. The databases are restored either way, so callers report
   * these separately from state restoration instead of failing the rollback or
   * blocking Gateway restart.
   */
  onJournalReconciliationFailures?: (failures: readonly string[]) => void;
}): Promise<string[] | null> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(params.runId)) {
    throw new Error("Database rollback requires its original update run identity.");
  }
  const { backup, assertCurrent } = params;
  const paths = [
    ...new Set([...backup.databases.map((entry) => entry.path), ...backup.missingPaths]),
  ].toSorted();
  const displaced: string[] = [];
  let preparedCopy: ReturnType<typeof adoptPreparedLocation> | undefined;
  let retainPreparedCopy = false;
  let outcome: { value: string[] | null } | { error: unknown };
  const outputs: Array<Awaited<ReturnType<typeof prepareVerifiedSqliteFile>>> = [];
  try {
    const result = await withDatabaseExclusion(
      params.env,
      paths,
      [...new Set([...backup.sourcePaths, ...paths])],
      assertCurrent,
      async (assertOwned) => {
        if (params.expectedGenerations) {
          assertOwned();
          const generations = await readUpdateDatabaseGenerationsIsolated(paths, {
            env: params.env,
            pluginOwners: backup.pluginOwners,
          });
          assertOwned();
          if (!isDeepStrictEqual(generations, params.expectedGenerations)) {
            const changed = paths.filter(
              (file) => generations[file] !== params.expectedGenerations?.[file],
            );
            backup.restoreRefusal = `Databases changed after ${backup.migration?.name ?? "snapshot capture"}: ${changed.join(", ")}; restoring the backup would discard later writes`;
            return null;
          }
        }
        assertOwned();
        // Verify the entire backup before moving any live file. Publication verifies
        // these exact digests again, so a changed backup never authorizes replacement.
        for (const entry of backup.databases) {
          const source = await fs.open(entry.snapshotPath, "r");
          try {
            const content = await sha256File(source);
            if (content.digest !== entry.sha256 || content.bytes !== entry.sizeBytes) {
              throw new Error(`Database snapshot changed: ${entry.snapshotPath}`);
            }
          } finally {
            await source.close();
          }
          assertOwned();
        }
        const sharedPath = resolvePathViaExistingAncestorSync(
          resolveOpenClawStateSqlitePath(params.env),
        );
        const shared = backup.databases.find((entry) => entry.path === sharedPath);
        const { prepareUpdateClientCredentialRestore } =
          await import("./client-credential-restore.js");
        const restoreClientCredentials = prepareUpdateClientCredentialRestore({
          backup,
          env: params.env,
        });
        assertOwned();
        const sources = [...backup.databases];
        for (const entry of sources) {
          if (entry.engine !== "postgres") {
            continue;
          }
          if (!entry.exportDirectory || !entry.storeId || !entry.namespace) {
            throw new Error("PostgreSQL rollback is missing its matched capture identity.");
          }
          const { createConfigIO } = await import("../config/io.js");
          const { config } = await createConfigIO({
            env: params.env,
            observe: false,
            pluginValidation: "core-only",
            shellEnvFallback: "defer",
          }).readConfigFileSnapshot();
          params.onLiveMutation?.();
          const { preparePostgresRestore } = await import("../snapshot/database-backup.js");
          // Keep prior recovery preparations intact without occupying a retry's fresh target.
          const snapshotPath = `${entry.snapshotPath}.restored-${params.runId}-${randomUUID()}`;
          const prepared = await preparePostgresRestore({
            directory: entry.exportDirectory,
            anchorPath: snapshotPath,
            config,
            pluginOwners: backup.pluginOwners,
            profile: "exact",
            assertCurrent: assertOwned,
            preserveUpdateHistory: entry.path === sharedPath,
            pluginCohortRecovery:
              entry.path === sharedPath ? params.pluginCohortRecovery : undefined,
            expectedSource: { storeId: entry.storeId, namespace: entry.namespace },
          });
          sources[sources.indexOf(entry)] = { ...entry, ...prepared, snapshotPath };
          displaced.push(`PostgreSQL namespace ${entry.namespace}`);
        }
        if (paths.includes(sharedPath) && shared?.engine !== "postgres") {
          if (!shared) {
            throw new Error(
              "Database rollback cannot preserve update history without its shared snapshot.",
            );
          }
          const stagingRoot = await createSqliteSnapshotStagingDirectory(backup.directory);
          const targetPath = path.join(stagingRoot, "shared.sqlite");
          preparedCopy = adoptPreparedLocation(targetPath, stagingRoot);
          const worker = { nodeRunner: process.execPath, sourceEnv: params.env, stagingRoot };
          assertOwned();
          const databases = await readUpdateStateDatabaseSizes(
            [sharedPath, shared.snapshotPath],
            worker,
          );
          assertOwned();
          const prepared = parseUpdateStateInspectionWorker(
            await runUpdateStateInspectionWorker({
              ...worker,
              databases,
              input: {
                mode: "database-restore-preparation",
                stateDir: resolveStateDir(params.env),
                config: {},
                baseline: shared,
                currentPath: sharedPath,
                targetPath,
                stagingRoot,
                pluginCohortRecovery: params.pluginCohortRecovery,
              },
            }),
            z.object({
              sha256: z.string().regex(/^[a-f0-9]{64}$/u),
              sizeBytes: z.number().int().nonnegative(),
              userVersion: z.number().int().nonnegative(),
            }),
          );
          assertOwned();
          sources[sources.indexOf(shared)] = { ...shared, ...prepared, snapshotPath: targetPath };
        }
        const moves: Array<{
          databasePath: string;
          source: string;
          target: string;
          identity: NonNullable<Awaited<ReturnType<typeof existingFile>>>;
        }> = [];
        for (const databasePath of paths) {
          for (const suffix of ["", "-wal", "-shm", "-journal"]) {
            const source = `${databasePath}${suffix}`;
            const target = `${databasePath}.migrated-${params.runId}${suffix}`;
            if (await existingFile(target)) {
              throw new Error(`Migrated database recovery file already exists: ${target}`);
            }
            const identity = await existingFile(source);
            if (identity) {
              moves.push({ databasePath, source, target, identity });
            }
          }
        }
        // Allocate every final writable image before moving any current family.
        // The shared source contains the actual current history, not its baseline size.
        for (const entry of sources) {
          assertOwned();
          const sourceIdentity = await fs.lstat(entry.snapshotPath, { bigint: true });
          assertOwned();
          outputs.push(
            await prepareVerifiedSqliteFile({
              sourcePath: entry.snapshotPath,
              sourceIdentity,
              targetPath: entry.path,
              expectedContent: { sha256: entry.sha256, sizeBytes: entry.sizeBytes },
              requireAtomicPublication: true,
              beforeByteCopy: (sizeBytes) => {
                const directory = path.dirname(entry.path);
                const space = tryReadDiskSpace(directory);
                const requiredBytes = sizeBytes + 64 * 1024 * 1024;
                if (!space || space.availableBytes < requiredBytes) {
                  throw new Error(
                    `Database rollback needs ${formatDiskSpaceBytes(requiredBytes)} near ${directory} for a writable copy; ${space ? `${formatDiskSpaceBytes(space.availableBytes)} is available` : "available space could not be measured"}. Current databases have not been moved.`,
                  );
                }
                assertOwned();
              },
              beforePublish: assertOwned,
              afterPublish: (guard) => guard.assertTargetMatchesExpectedContent(assertOwned),
            }),
          );
          assertOwned();
        }
        // Cleanup may remove these files only after a later verified update, by this receipt.
        // Bookkeeping never blocks a rollback: without a receipt the files stay protected.
        await writeDisplacedDatabaseReceipts(params.runId, moves).catch(() => undefined);
        assertOwned();
        params.onLiveMutation?.();
        for (const move of moves) {
          assertOwned();
          try {
            await publishFileExclusive({
              sourcePath: move.source,
              targetPath: move.target,
              expectedSourceIdentity: move.identity,
              strategy: "rename-noreplace",
            });
          } catch (error) {
            // The publisher marks every failure after rename; an unmarked refusal leaves the source in place.
            retainPreparedCopy ||=
              getPublishFileExclusiveFailureDetails(error)?.targetCreated === true;
            throw error;
          }
          retainPreparedCopy = true;
          displaced.push(move.target);
          assertOwned();
        }
        for (const output of outputs) {
          assertOwned();
          retainPreparedCopy = true;
          await output.publish();
          assertOwned();
        }
        // Snapshot images are single DELETE-journal files by design, so restored
        // databases come back in rollback-journal mode. Re-establish the journal
        // mode each path resolves to while the exclusion window still keeps every
        // other holder out; leaving DELETE behind makes the next update's
        // maintenance lease fail sqlite-busy against the updater's own readers and
        // rolls the same failure forward on every retry. The client credential
        // store is excluded: its exclusive custody design requires DELETE mode.
        // Journal reconciliation is recoverable: credential rebinding below always
        // completes first, and failures surface through
        // onJournalReconciliationFailures instead of failing the published
        // restoration or blocking Gateway restart.
        const credentialStorePath = resolvePathViaExistingAncestorSync(
          resolveClientCredentialStorePath(params.env),
        );
        const journalModeFailures: string[] = [];
        for (const entry of sources) {
          assertOwned();
          if (entry.path === credentialStorePath) {
            continue;
          }
          try {
            await reestablishRestoredDatabaseJournalMode(entry.path);
          } catch (error) {
            journalModeFailures.push(`${entry.path}: ${formatErrorMessage(error)}`);
          }
        }
        restoreClientCredentials?.();
        assertOwned();
        if (journalModeFailures.length > 0) {
          params.onJournalReconciliationFailures?.(journalModeFailures);
        }
        assertOwned();
        return displaced;
      },
    );
    retainPreparedCopy = false;
    outcome = { value: result };
  } catch (error) {
    outcome = { error };
    retainPreparedCopy ||= hasCommandProcessCleanupError(error);
  }
  if (retainPreparedCopy) {
    if (preparedCopy) {
      // Unfinished publication or child settlement retains its prepared bytes for recovery.
      releaseSnapshotTempDirectory(path.dirname(preparedCopy.location));
    }
  } else {
    // Join all cleanup even if one output cannot be retired.
    const cleanup = await Promise.allSettled([
      ...outputs.map((output) => output.cleanup()),
      ...(preparedCopy ? [preparedCopy.cleanupAsync()] : []),
    ]);
    const failures = cleanup.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      const errors = [
        ...("error" in outcome ? [outcome.error] : []),
        ...failures.map((result) => result.reason),
      ];
      throw createSqliteLifecycleAggregateError(
        errors,
        "Database rollback output cleanup failed",
        errors[0],
      );
    }
  }
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.value;
}
