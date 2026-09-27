import fs from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { drainAgentDatabaseResources } from "../state/openclaw-agent-db-resources.js";
import { prepareOpenClawStateDatabaseRemoval } from "../state/openclaw-state-db-cache.js";
import { publishFileExclusive, sha256File } from "./directory-durability.js";
import { hasErrnoCode } from "./errno.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import { createSqliteLifecycleAggregateError } from "./sqlite-lifecycle-errors.js";
import { publishVerifiedSqliteFile } from "./sqlite-snapshot.js";
import { readUpdateDatabaseGenerationsIsolated } from "./update-candidate-state.js";
import type { UpdateDatabaseBackup } from "./update-database-backup.js";
import type { UpdateDatabaseGenerations } from "./update-database-generations.js";

async function existingFile(file: string) {
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.nlink !== 1) {
      throw new Error(`Database recovery requires a regular, unaliased file: ${file}`);
    }
    return info;
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
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
  const acquire = async (index: number): Promise<T> => {
    const databasePath = paths[index];
    if (databasePath === undefined) {
      return operation(assertOwned);
    }
    const exclusion = await prepareOpenClawStateDatabaseRemoval(databasePath, assertCurrent);
    exclusions.push(exclusion);
    assertOwned();
    return acquire(index + 1);
  };
  const drain = async (index: number): Promise<T> => {
    const pathname = sourcePaths[index];
    if (pathname === undefined) {
      return acquire(0);
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

/** The caller owns a settled failed candidate that has never been allowed to serve. */
export async function restoreUpdateDatabaseBackup(params: {
  backup: UpdateDatabaseBackup;
  runId: string;
  env: NodeJS.ProcessEnv;
  assertCurrent: () => void;
  expectedGenerations?: UpdateDatabaseGenerations;
}): Promise<string[] | null> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(params.runId)) {
    throw new Error("Database rollback requires its original update run identity.");
  }
  const { backup, assertCurrent } = params;
  const paths = [
    ...new Set([...backup.databases.map((entry) => entry.path), ...backup.missingPaths]),
  ].toSorted();
  const displaced: string[] = [];
  return await withDatabaseExclusion(
    params.env,
    paths,
    [...new Set([...backup.sourcePaths, ...paths])],
    assertCurrent,
    async (assertOwned) => {
      if (params.expectedGenerations) {
        assertOwned();
        const generations = await readUpdateDatabaseGenerationsIsolated(paths, { env: params.env });
        assertOwned();
        if (!isDeepStrictEqual(generations, params.expectedGenerations)) {
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
      const moves: Array<{
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
            moves.push({ source, target, identity });
          }
        }
      }
      for (const move of moves) {
        assertOwned();
        await publishFileExclusive({
          sourcePath: move.source,
          targetPath: move.target,
          expectedSourceIdentity: move.identity,
          strategy: "rename-noreplace",
        });
        displaced.push(move.target);
        assertOwned();
      }
      for (const entry of backup.databases) {
        assertOwned();
        const sourceIdentity = await fs.lstat(entry.snapshotPath);
        await publishVerifiedSqliteFile({
          sourcePath: entry.snapshotPath,
          sourceIdentity,
          targetPath: entry.path,
          expectedContent: { sha256: entry.sha256, sizeBytes: entry.sizeBytes },
          requireAtomicPublication: true,
          beforePublish: assertOwned,
          afterPublish: (guard) => guard.assertTargetMatchesExpectedContent(assertOwned),
        });
        assertOwned();
      }
      return displaced;
    },
  );
}
