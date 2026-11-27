import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { syncDirectoryIfSupported } from "../../../infra/directory-durability.js";
import { hasErrnoCode } from "../../../infra/errno.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { isUpdateRehearsalReadOnlyPath } from "../../../infra/update-rehearsal-paths.js";

const LEGACY_CRON_ARCHIVE_SUFFIX = ".migrated";

async function legacyCronFileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (err) {
    if (hasErrnoCode(err, "ENOENT")) {
      return false;
    }
    throw err;
  }
}

type ArchiveOutcome =
  | { ok: true; archivePath?: string }
  | { ok: false; reason: string; deferred?: true };

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");
}

async function restoreArchivedSource(
  archivePath: string,
  sourcePath: string,
  expectedSha256?: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    if (await legacyCronFileExists(sourcePath)) {
      return {
        ok: false,
        reason: `archive remains at ${archivePath} because a new source exists at ${sourcePath}`,
      };
    }
  } catch (err) {
    return {
      ok: false,
      reason: `archive remains at ${archivePath} because the source path could not be checked: ${formatErrorMessage(err)}`,
    };
  }
  try {
    await fs.rename(archivePath, sourcePath);
  } catch (err) {
    if (hasErrnoCode(err, "EXDEV")) {
      const outcome = await copyLegacyCronFileAcrossDevices(
        archivePath,
        sourcePath,
        expectedSha256,
        false,
      );
      return outcome.ok ? { ok: true } : outcome;
    }
    return {
      ok: false,
      reason: `archive remains at ${archivePath} because restoration failed: ${formatErrorMessage(err)}`,
    };
  }
  try {
    await syncDirectoryIfSupported(path.dirname(sourcePath));
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: `the source was restored, but rollback directory sync failed: ${formatErrorMessage(err)}`,
    };
  }
}

async function copyLegacyCronFileAcrossDevices(
  filePath: string,
  initialArchivePath: string,
  expectedSha256?: string,
  useNumberedArchive = true,
): Promise<ArchiveOutcome> {
  let archivePath = initialArchivePath;
  let archiveCreated = false;
  let sourceRemoved = false;
  try {
    const sourceStat = await fs.stat(filePath);
    if (!sourceStat.isFile()) {
      throw new Error("legacy cron source is not a regular file");
    }
    if (expectedSha256 && (await sha256File(filePath)) !== expectedSha256) {
      throw new Error("legacy cron source changed after it was imported; refusing to archive it");
    }
    const sourceMode = sourceStat.mode & 0o777;
    for (let index = 2; ; index += 1) {
      try {
        const archiveHandle = await fs.open(archivePath, "wx", sourceMode | 0o600);
        archiveCreated = true;
        await archiveHandle.close();
        break;
      } catch (err) {
        if (!hasErrnoCode(err, "EEXIST") || !useNumberedArchive) {
          throw err;
        }
        archivePath = `${filePath}${LEGACY_CRON_ARCHIVE_SUFFIX}.${index}`;
      }
    }

    // Claim the destination before copyFile so any partial output from a failed,
    // non-atomic copy is owned by this attempt and removed by the catch path.
    await fs.copyFile(filePath, archivePath);
    if (expectedSha256 && (await sha256File(archivePath)) !== expectedSha256) {
      throw new Error("copied legacy cron archive does not match the imported source");
    }
    await fs.chmod(archivePath, sourceMode | 0o600);
    const archiveHandle = await fs.open(archivePath, "r+");
    try {
      await archiveHandle.chmod(sourceMode);
      await archiveHandle.utimes(sourceStat.atime, sourceStat.mtime);
      await archiveHandle.sync();
    } finally {
      await archiveHandle.close();
    }
    await syncDirectoryIfSupported(path.dirname(archivePath));
    const currentSourceStat = await fs.stat(filePath);
    if (
      currentSourceStat.dev !== sourceStat.dev ||
      currentSourceStat.ino !== sourceStat.ino ||
      (expectedSha256 && (await sha256File(filePath)) !== expectedSha256)
    ) {
      throw new Error("legacy cron source changed during archival; refusing to remove it");
    }
    // Current OpenClaw runtime never writes legacy JSON. POSIX has no conditional
    // unlink, so hashes close observed external edits before migration-owned removal.
    await fs.unlink(filePath);
    sourceRemoved = true;
    await syncDirectoryIfSupported(path.dirname(filePath));
    return { ok: true, archivePath };
  } catch (err) {
    if (sourceRemoved) {
      return {
        ok: false,
        reason: `${formatErrorMessage(err)}; the durable archive is preserved at ${archivePath} because the source was already removed`,
      };
    }
    let cleanupReason = "";
    if (archiveCreated) {
      let archiveRemoved = false;
      try {
        try {
          await fs.unlink(archivePath);
        } catch (cleanupErr) {
          if (!hasErrnoCode(cleanupErr, "ENOENT")) {
            throw cleanupErr;
          }
        }
        archiveRemoved = true;
        await syncDirectoryIfSupported(path.dirname(archivePath));
      } catch (cleanupErr) {
        cleanupReason = archiveRemoved
          ? `; the partial archive was removed, but cleanup directory sync failed: ${formatErrorMessage(cleanupErr)}`
          : `; partial archive remains at ${archivePath} because cleanup failed: ${formatErrorMessage(cleanupErr)}`;
      }
    }
    return { ok: false, reason: `${formatErrorMessage(err)}${cleanupReason}` };
  }
}

/** Archives an imported legacy cron artifact only after its source bytes are verified. */
export async function archiveLegacyCronFile(
  filePath: string,
  expectedSha256?: string,
): Promise<ArchiveOutcome> {
  let archivePath = `${filePath}${LEGACY_CRON_ARCHIVE_SUFFIX}`;
  try {
    if (!(await legacyCronFileExists(filePath))) {
      return { ok: true };
    }
    for (let index = 2; await legacyCronFileExists(archivePath); index += 1) {
      archivePath = `${filePath}${LEGACY_CRON_ARCHIVE_SUFFIX}.${index}`;
    }
  } catch (err) {
    return { ok: false, reason: formatErrorMessage(err) };
  }

  if (isUpdateRehearsalReadOnlyPath(filePath, process.env)) {
    return {
      ok: false,
      deferred: true,
      reason: `Update rehearsal retained legacy cron source at ${filePath}; Doctor will archive it during the live update.`,
    };
  }
  try {
    await fs.rename(filePath, archivePath);
  } catch (err) {
    // A cross-device rename can occur when the configured store is a mounted file.
    // Fsync before source removal and roll back failed cleanup so retries stay idempotent.
    if (!hasErrnoCode(err, "EXDEV")) {
      return { ok: false, reason: formatErrorMessage(err) };
    }
    return await copyLegacyCronFileAcrossDevices(filePath, archivePath, expectedSha256);
  }

  try {
    if (expectedSha256 && (await sha256File(archivePath)) !== expectedSha256) {
      throw new Error("legacy cron source changed after it was imported; refusing to archive it");
    }
    await syncDirectoryIfSupported(path.dirname(filePath));
    if (await legacyCronFileExists(filePath)) {
      return {
        ok: false,
        reason: `the imported source was archived, but a new legacy cron source now exists at ${filePath}`,
      };
    }
    return { ok: true, archivePath };
  } catch (err) {
    const restoreFailure = await restoreArchivedSource(archivePath, filePath, expectedSha256);
    return {
      ok: false,
      reason: restoreFailure.ok
        ? formatErrorMessage(err)
        : `${formatErrorMessage(err)}; ${restoreFailure.reason}`,
    };
  }
}
