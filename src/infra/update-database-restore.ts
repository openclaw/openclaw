import fs from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { drainAgentDatabaseResources } from "../state/openclaw-agent-db-resources.js";
import { acquireOpenClawStateDatabaseFileExclusion } from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { publishFileExclusive, sha256File } from "./directory-durability.js";
import { hasErrnoCode } from "./errno.js";
import { publishVerifiedSqliteFile } from "./sqlite-snapshot.js";
import {
  acquireGatewayMaintenanceCoordinator,
  acquireStateDatabaseCoordinator,
  acquireStateDatabaseHandleExclusion,
} from "./state-database-coordinator.js";
import type { UpdateDatabaseBackup } from "./update-database-backup.js";
import {
  readUpdateDatabaseGenerations,
  type UpdateDatabaseGenerations,
} from "./update-database-generations.js";

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
  shared: string,
  paths: string[],
  sourcePaths: string[],
  assertCurrent: () => void,
  operation: (assertOwned: () => void) => Promise<T>,
): Promise<T> {
  using owners = new DisposableStack();
  const retain = (owner: { release: () => void }) => owners.defer(() => owner.release());
  const exclusions: Array<{ assertCurrent: () => void }> = [];
  const assertOwned = () => {
    assertCurrent();
    for (const exclusion of exclusions) {
      exclusion.assertCurrent();
    }
  };
  assertCurrent();
  // These coordinators live outside the replaced databases. Keep every owner
  // and local admission seal until the complete family, including the ledger, is restored.
  retain(acquireGatewayMaintenanceCoordinator({ databasePath: shared, busyTimeoutMs: 0 }));
  const canonicalShared = resolvePathViaExistingAncestorSync(shared);
  for (const databasePath of paths) {
    retain(acquireStateDatabaseCoordinator({ databasePath, busyTimeoutMs: 0 }));
  }
  const acquire = async (index: number): Promise<T> => {
    const databasePath = paths[index];
    if (databasePath === undefined) {
      return operation(assertOwned);
    }
    if (databasePath === canonicalShared) {
      const exclusion = await acquireOpenClawStateDatabaseFileExclusion(shared);
      retain(exclusion);
      exclusions.push(exclusion);
      assertOwned();
      return acquire(index + 1);
    }
    const exclusion = acquireStateDatabaseHandleExclusion({ databasePath, busyTimeoutMs: 0 });
    retain(exclusion);
    exclusions.push(exclusion);
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
  return await drain(0);
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
  const shared = resolveOpenClawStateSqlitePath(params.env);
  const paths = [
    ...new Set([...backup.databases.map((entry) => entry.path), ...backup.missingPaths]),
  ].toSorted();
  const displaced: string[] = [];
  return await withDatabaseExclusion(
    shared,
    paths,
    [...new Set([...backup.sourcePaths, ...paths])],
    assertCurrent,
    async (assertOwned) => {
      if (
        params.expectedGenerations &&
        !isDeepStrictEqual(readUpdateDatabaseGenerations(paths), params.expectedGenerations)
      ) {
        return null;
      }
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
