import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { sameFileIdentity } from "@openclaw/fs-safe/advanced";
import {
  removePreparedBackupArchive,
  type BackupArchiveCleanupReceipt,
  type PreparedBackupArchive,
} from "./backup-create-stream.js";
import {
  createBackupScratchDirectory,
  finishBackupScratch,
  maintainBackupScratch,
  type BackupScratch,
} from "./backup-scratch.js";
import { BACKUP_ARCHIVE_STAGING_BASENAME } from "./backup-tar-retry.js";
import {
  getPublishFileExclusiveFailureDetails,
  isHardlinkFallbackError,
  publishFileExclusive,
  requireDirectorySync,
  syncDirectoryIfSupported,
} from "./directory-durability.js";
import { isSqliteLockError, isSqliteNativeOpenFailure } from "./sqlite-error-diagnostics.js";
import { createPrivateSqliteTempDirectory } from "./sqlite-private-directory.js";
import { SqliteStagingOwnershipUnknownError } from "./sqlite-staging-token.js";

type BackupArchiveLogger = (message: string) => void;

export type BackupArchivePublication = {
  canonicalOutputPath: string;
  canonicalParentPath: string;
  parentReceipt: { path: string; realPath: string; identity: BigIntStats };
  pendingCleanupArchives: BackupArchiveCleanupReceipt[];
  requestedOutputPath: string;
  requestedParentPath: string;
  stagingDir: string;
  stagingIdentity: BigIntStats;
  scratch?: BackupScratch;
  tempArchivePath: string;
  warnings: string[];
};

function pathsEqual(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

async function assertTargetAbsent(targetPath: string): Promise<void> {
  try {
    await fs.lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`Refusing to overwrite existing backup archive: ${targetPath}`);
}

async function removeDirectoryIfOwned(
  directoryPath: string,
  expectedIdentity: BigIntStats,
): Promise<boolean> {
  // This is a cooperative same-user fence, not hostile local-user isolation;
  // SECURITY.md treats co-equal host mutation as inside the operator boundary.
  const currentIdentity = await fs.lstat(directoryPath, { bigint: true }).catch(() => undefined);
  if (
    !currentIdentity ||
    !currentIdentity.isDirectory() ||
    (process.platform === "win32" &&
      (expectedIdentity.dev === 0n ||
        expectedIdentity.ino === 0n ||
        currentIdentity.dev === 0n ||
        currentIdentity.ino === 0n)) ||
    !sameFileIdentity(expectedIdentity, currentIdentity)
  ) {
    return false;
  }
  try {
    await fs.rmdir(directoryPath);
    return true;
  } catch {
    return false;
  }
}

async function removeStagingDirectoryIfOwned(plan: BackupArchivePublication): Promise<boolean> {
  if (plan.scratch) {
    // Archive receipts are settled by the publication owner, before the scratch
    // owner retires its controls. Never reinterpret an unresolved receipt.
    if (
      plan.pendingCleanupArchives.length ||
      (await fs.lstat(plan.tempArchivePath).then(
        () => true,
        (error: unknown) => (error as NodeJS.ErrnoException).code !== "ENOENT",
      ))
    ) {
      plan.scratch.release();
      return false;
    }
    const warning = await finishBackupScratch(plan.scratch);
    if (!warning) {
      plan.scratch = undefined;
      return true;
    }
    if (!plan.warnings.includes(warning)) {
      plan.warnings.push(warning);
    }
    return false;
  }
  return await removeDirectoryIfOwned(plan.stagingDir, plan.stagingIdentity);
}
export async function createBackupArchivePublication(
  outputPath: string,
  log?: BackupArchiveLogger,
): Promise<BackupArchivePublication> {
  const requestedOutputPath = path.resolve(outputPath);
  const requestedParentPath = path.dirname(requestedOutputPath);
  const canonicalParentPath = await fs.realpath(requestedParentPath);
  const parentIdentity = await fs.lstat(canonicalParentPath, { bigint: true });
  if (!parentIdentity.isDirectory()) {
    throw new Error(`Backup output parent is not a directory: ${requestedParentPath}`);
  }
  const canonicalOutputPath = path.join(canonicalParentPath, path.basename(requestedOutputPath));
  await assertTargetAbsent(canonicalOutputPath);
  const maintenance = await maintainBackupScratch({
    roots: [canonicalParentPath],
    repair: true,
    kind: "publication",
    log,
  });
  const warnings = [...maintenance.warnings];
  let scratch: BackupScratch | undefined;
  let stagingDir: string;
  try {
    scratch = await createBackupScratchDirectory(canonicalParentPath, "publication");
    stagingDir = scratch.directory;
  } catch (error) {
    if (error instanceof SqliteStagingOwnershipUnknownError) {
      throw new Error(
        `Backup publication staging requires stable file identity in ${canonicalParentPath}; choose a destination that reports file identities reliably.`,
        { cause: error },
      );
    }
    if (!isSqliteNativeOpenFailure(error) && !isSqliteLockError(error)) {
      throw error;
    }
    // Destinations without usable SQLite locking cannot authorize recovery.
    // Continue in a private, deliberately unregistered directory; never
    // reclaim it by name. Unknown file identity fails explicitly above because
    // this fallback could not safely remove a full staged archive after publish.
    stagingDir = await createPrivateSqliteTempDirectory(
      canonicalParentPath,
      ".openclaw-backup-publish-unowned-",
    );
    const warning = `Backup destination does not support recoverable SQLite staging; automatic recovery is disabled for ${stagingDir}.`;
    warnings.push(warning);
    log?.(warning);
  }
  let stagingIdentity: BigIntStats | undefined;
  try {
    stagingIdentity = await fs.lstat(stagingDir, { bigint: true });
    await fs.chmod(stagingDir, 0o700);
    return {
      canonicalOutputPath,
      canonicalParentPath,
      parentReceipt: {
        path: canonicalParentPath,
        realPath: canonicalParentPath,
        identity: parentIdentity,
      },
      pendingCleanupArchives: [],
      requestedOutputPath,
      requestedParentPath,
      stagingDir,
      stagingIdentity,
      scratch,
      tempArchivePath: path.join(stagingDir, BACKUP_ARCHIVE_STAGING_BASENAME),
      warnings,
    };
  } catch (error) {
    if (scratch) {
      await finishBackupScratch(scratch, log);
    } else if (stagingIdentity) {
      await removeDirectoryIfOwned(stagingDir, stagingIdentity);
    }
    throw error;
  }
}

function retainArchiveForCleanup(
  plan: BackupArchivePublication,
  receipt: BackupArchiveCleanupReceipt,
): void {
  for (const [index, candidate] of plan.pendingCleanupArchives.entries()) {
    if (!pathsEqual(candidate.archivePath, receipt.archivePath)) {
      continue;
    }
    if (!candidate.identity || !receipt.identity) {
      if (!candidate.identity && receipt.identity) {
        plan.pendingCleanupArchives[index] = receipt;
      }
      return;
    }
    if (sameFileIdentity(candidate.identity, receipt.identity)) {
      return;
    }
  }
  plan.pendingCleanupArchives.push(receipt);
}

async function removePendingBackupArchive(
  plan: BackupArchivePublication,
  receipt: BackupArchiveCleanupReceipt,
): Promise<boolean> {
  if (!pathsEqual(path.dirname(receipt.archivePath), plan.stagingDir)) {
    return false;
  }
  if (receipt.identity) {
    // SAFETY: an identity-bearing cleanup receipt satisfies PreparedBackupArchive.
    return removePreparedBackupArchive(receipt as PreparedBackupArchive);
  }
  let currentIdentity: BigIntStats;
  try {
    currentIdentity = await fs.lstat(receipt.archivePath, { bigint: true });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  if (!currentIdentity.isFile()) {
    return false;
  }
  return removePreparedBackupArchive({
    archivePath: receipt.archivePath,
    identity: currentIdentity,
  });
}

export async function cleanupBackupArchivePublication(
  plan: BackupArchivePublication,
  log?: BackupArchiveLogger,
): Promise<void> {
  const retainedArchives = plan.pendingCleanupArchives.splice(0);
  for (const receipt of retainedArchives) {
    if (!(await removePendingBackupArchive(plan, receipt))) {
      retainArchiveForCleanup(plan, receipt);
    }
  }
  if (await removeStagingDirectoryIfOwned(plan)) {
    await syncDirectoryIfSupported(plan.canonicalParentPath).catch(() => undefined);
    return;
  }
  const currentIdentity = await fs.lstat(plan.stagingDir).catch(() => undefined);
  if (currentIdentity) {
    log?.(`Backup archiver preserved changed or non-empty staging directory ${plan.stagingDir}.`);
  }
}

export async function publishPreparedBackupArchive(params: {
  plan: BackupArchivePublication;
  prepared: PreparedBackupArchive;
  log?: BackupArchiveLogger;
}): Promise<void> {
  const { plan, prepared } = params;
  let publicationPreserved = false;
  let committed = false;
  try {
    try {
      const publication = await publishFileExclusive({
        sourcePath: prepared.archivePath,
        targetPath: plan.canonicalOutputPath,
        expectedSourceIdentity: prepared.identity,
        parentReceipt: plan.parentReceipt,
        strategy: "link-required",
        onSyncFailure: "preserve",
      });
      publicationPreserved = true;
      requireDirectorySync(publication.directorySync, "Backup publication directory");
      committed = true;
    } catch (error) {
      const details = getPublishFileExclusiveFailureDetails(error);
      publicationPreserved ||= details?.cleanup === "preserved";
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          `Refusing to overwrite existing backup archive: ${plan.requestedOutputPath}`,
          { cause: error },
        );
      }
      if (isHardlinkFallbackError(error)) {
        throw new Error(
          `Atomic backup publication requires hard-link support in ${plan.requestedParentPath}.`,
          { cause: error },
        );
      }
      if ((error as { code?: unknown }).code === "path-mismatch") {
        throw new Error(`Backup archive changed during publication: ${plan.requestedOutputPath}`, {
          cause: error,
        });
      }
      throw error;
    }

    if (!removePreparedBackupArchive(prepared)) {
      retainArchiveForCleanup(plan, prepared);
      params.log?.(`Backup archiver preserved changed staging file ${prepared.archivePath}.`);
    }
    if (!(await removeStagingDirectoryIfOwned(plan))) {
      params.log?.(
        `Backup archiver preserved changed or non-empty staging directory ${plan.stagingDir}.`,
      );
    }
    await syncDirectoryIfSupported(plan.canonicalParentPath).catch((error: unknown) => {
      params.log?.(
        `Backup archiver could not sync cleanup in ${plan.canonicalParentPath}: ${
          (error as NodeJS.ErrnoException).code ?? String(error)
        }.`,
      );
    });
  } catch (error) {
    if (!committed) {
      if (publicationPreserved) {
        params.log?.(
          `Backup archiver preserved the final archive after publication failed: ${plan.requestedOutputPath}.`,
        );
      }
      if (!removePreparedBackupArchive(prepared)) {
        retainArchiveForCleanup(plan, prepared);
      }
      await removeStagingDirectoryIfOwned(plan);
    }
    throw error;
  }
}
