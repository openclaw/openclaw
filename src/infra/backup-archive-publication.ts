import { randomUUID } from "node:crypto";
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
  getPublishFileExclusiveFailureDetails,
  isHardlinkFallbackError,
  publishFileExclusive,
  requireDirectorySync,
  syncDirectoryIfSupported,
} from "./directory-durability.js";

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
  tempArchivePath: string;
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

export async function createBackupArchivePublication(
  outputPath: string,
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
  const stagingDir = await fs.mkdtemp(
    path.join(canonicalParentPath, `.openclaw-backup-publish-${randomUUID()}-`),
  );
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
      tempArchivePath: path.join(stagingDir, "archive.tar.gz.tmp"),
    };
  } catch (error) {
    if (stagingIdentity) {
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
    if (candidate.identity && receipt.identity) {
      if (!sameFileIdentity(candidate.identity, receipt.identity)) {
        continue;
      }
    } else if (!candidate.identity && receipt.identity) {
      plan.pendingCleanupArchives[index] = receipt;
    }
    return;
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
  let identity = receipt.identity;
  if (!identity) {
    try {
      identity = await fs.lstat(receipt.archivePath, { bigint: true });
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
    if (!identity.isFile()) {
      return false;
    }
  }
  return removePreparedBackupArchive({ archivePath: receipt.archivePath, identity });
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
  if (await removeDirectoryIfOwned(plan.stagingDir, plan.stagingIdentity)) {
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
  let publicationFailure: { error: unknown } | undefined;
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
    } catch (error) {
      const details = getPublishFileExclusiveFailureDetails(error);
      publicationPreserved ||= details?.cleanup === "preserved";
      let message: string;
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        message = `Refusing to overwrite existing backup archive: ${plan.requestedOutputPath}`;
      } else if (isHardlinkFallbackError(error)) {
        message = `Atomic backup publication requires hard-link support in ${plan.requestedParentPath}.`;
      } else if ((error as { code?: unknown }).code === "path-mismatch") {
        message = `Backup archive changed during publication: ${plan.requestedOutputPath}`;
      } else {
        throw error;
      }
      throw new Error(message, { cause: error });
    }
  } catch (error) {
    publicationFailure = { error };
  }
  if (publicationFailure && publicationPreserved) {
    params.log?.(
      `Backup archiver preserved the final archive after publication failed: ${plan.requestedOutputPath}.`,
    );
  }
  if (!removePreparedBackupArchive(prepared)) {
    retainArchiveForCleanup(plan, prepared);
    if (!publicationFailure) {
      params.log?.(`Backup archiver preserved changed staging file ${prepared.archivePath}.`);
    }
  }
  const removed = await removeDirectoryIfOwned(plan.stagingDir, plan.stagingIdentity);
  if (publicationFailure) {
    throw publicationFailure.error;
  }
  if (!removed) {
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
}
