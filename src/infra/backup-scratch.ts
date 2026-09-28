import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sameFileIdentity } from "@openclaw/fs-safe/advanced";
import { getChildLogger } from "../logging/logger.js";
import { isMissingPathError } from "./errno.js";
import { formatErrorMessage, hasErrnoCode } from "./errors.js";
import { FsSafeError, root as createRoot, type Root } from "./fs-safe.js";
import { isSqliteLockError, isSqliteNativeOpenFailure } from "./sqlite-error-diagnostics.js";
import { createPrivateSqliteTempDirectory } from "./sqlite-private-directory.js";
import {
  acquireSqliteStagingToken,
  SQLITE_STAGING_TOKEN_FILES,
  SqliteStagingRetiredError,
  type SqliteStagingToken,
} from "./sqlite-staging-token.js";

const scratchName =
  /^openclaw-backup-(?:owned-|retired-)?(?:[A-Za-z0-9]{6}|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/u;
const ownedPrefix = "openclaw-backup-owned-";
const retiredPrefix = "openclaw-backup-retired-";

export type BackupScratch = { directory: string; release: SqliteStagingToken; boundary: Root };

export type BackupScratchReport = {
  reclaimed: string[];
  alreadyReclaimed: string[];
  active: string[];
  unchecked: string[];
  warnings: string[];
};

export async function createBackupScratchDirectory(root: string): Promise<BackupScratch> {
  for (let attempt = 0; ; attempt += 1) {
    const directory = await createPrivateSqliteTempDirectory(root, ownedPrefix);
    let boundary: Root | undefined;
    try {
      boundary = await createRoot(directory);
      const observed = await fs.lstat(directory);
      if (!observed.isDirectory() || !sameFileIdentity(observed, await boundary.stat("."))) {
        throw new Error("Backup scratch directory identity changed");
      }
      return { directory, boundary, release: acquireSqliteStagingToken(directory, "create") };
    } catch (error) {
      // A reclaimer can win before BEGIN IMMEDIATE. No payload exists yet;
      // leave that attempt to its new owner and allocate a fresh directory.
      if (
        isSqliteLockError(error) ||
        error instanceof SqliteStagingRetiredError ||
        isMissingPathError(error) ||
        ((isSqliteNativeOpenFailure(error) ||
          (error instanceof FsSafeError &&
            error.code === "path-mismatch" &&
            isMissingPathError(error.cause))) &&
          (await wasScratchReclaimed(directory)))
      ) {
        if (attempt < 2) {
          continue;
        }
        throw error;
      }
      await cleanupBackupScratchDirectory(directory, boundary);
      throw error;
    }
  }
}

function reportScratchMessage(
  message: string,
  log?: (message: string) => void,
  level: "warn" | "info" = "warn",
): void {
  try {
    if (log) {
      log(message);
      return;
    }
  } catch {
    // A caller's output failure must not replace the backup's own outcome.
  }
  try {
    getChildLogger({ subsystem: "infra/backup" })[level](message);
  } catch {
    // The caller also retains the warning in its structured result.
  }
}

async function wasScratchReclaimed(directory: string): Promise<boolean> {
  try {
    await fs.lstat(directory);
    return false;
  } catch (inspectionError) {
    return isMissingPathError(inspectionError);
  }
}

async function inspectScratchPayload(
  directory: string,
  layout: "root" | "snapshot" | "verification" | "sqlite" = "root",
): Promise<void> {
  for (const name of await fs.readdir(directory)) {
    const location = path.join(directory, name);
    const item = await fs.lstat(location);
    if (process.getuid && item.uid !== process.getuid()) {
      throw new Error(`Scratch file ownership is unknown: ${location}`);
    }
    if (item.isDirectory()) {
      const nested =
        layout === "root" && /^state-snapshot-(?:no-legacy|attempt-[1-3])$/u.test(name)
          ? "snapshot"
          : layout === "snapshot" && name === "legacy-verification"
            ? "verification"
            : layout !== "sqlite" &&
                /^\.sqlite-(?:snapshot-|publish-[\da-f-]{36}-)(?:[A-Za-z0-9]{6}|[\da-f-]{36})$/u.test(
                  name,
                )
              ? "sqlite"
              : undefined;
      if (nested) {
        await inspectScratchPayload(location, nested);
        continue;
      }
    } else if (
      item.isFile() &&
      ((layout === "root" &&
        (SQLITE_STAGING_TOKEN_FILES.some((control) => control === name) ||
          /^config-\d+$/u.test(name))) ||
        (layout === "sqlite"
          ? /^database\.sqlite(?:-wal|-shm|-journal)?$/u.test(name)
          : /^(?:openclaw-state-db-\d+\.sqlite(?:-wal|-shm|-journal)?|legacy-audit-raw-\d+\.jsonl)$/u.test(
              name,
            )))
    ) {
      continue;
    }
    throw new Error(`Unrecognized backup scratch content: ${location}`);
  }
}

async function removeBackupScratchPayload(boundary: Root): Promise<void> {
  for await (const entry of boundary.entries(".")) {
    if (!SQLITE_STAGING_TOKEN_FILES.some((control) => control === entry.name)) {
      await boundary.remove(entry.name, {
        recursive: true,
        force: true,
        mutationSymlinks: "reject",
        maxEntries: Infinity,
        maxDepth: Infinity,
      });
    }
  }
}

async function cleanupBackupScratchDirectory(
  initialDirectory: string,
  initialBoundary: Root | undefined,
  log?: (message: string) => void,
): Promise<
  | { status: "reclaimed" }
  | { status: "already-reclaimed"; directory: string }
  | { status: "failed"; warning: string }
> {
  let directory = initialDirectory;
  let boundary = initialBoundary;
  try {
    if (boundary && !path.basename(directory).startsWith(retiredPrefix)) {
      const expected = await boundary.stat(".");
      const parent = await createRoot(path.dirname(directory));
      const retiredPath = await createPrivateSqliteTempDirectory(parent.rootReal, retiredPrefix);
      const retiredName = path.basename(retiredPath);
      const reservation = await fs.lstat(retiredPath);
      // The committed token fenced every writer before this move into our empty reservation.
      // The retired name survives failures after the token itself is removed.
      await parent.move(path.basename(directory), retiredName, {
        overwrite: true,
        mutationSymlinks: "reject",
        assertBeforeMutation: () => {
          const current = fsSync.lstatSync(directory);
          const destination = fsSync.lstatSync(retiredPath);
          if (
            !current.isDirectory() ||
            !sameFileIdentity(expected, current) ||
            !destination.isDirectory() ||
            !sameFileIdentity(reservation, destination)
          ) {
            throw new Error("Backup scratch directory identity changed");
          }
        },
      });
      directory = path.join(parent.rootReal, retiredName);
      boundary = await createRoot(directory);
      if (!sameFileIdentity(expected, await boundary.stat("."))) {
        throw new Error("Retired backup scratch directory identity changed");
      }
    }
    // Payload was removed under the exclusive token before committing retirement.
    // Only the controls and empty directory remain after the handles close.
    if (boundary) {
      for (const control of SQLITE_STAGING_TOKEN_FILES) {
        await boundary.remove(control, { force: true, mutationSymlinks: "reject" });
      }
      await boundary.stat(".");
    }
    // rmdir never follows a substituted final symlink or removes new payloads.
    await fs.rmdir(directory);
    return { status: "reclaimed" };
  } catch (error) {
    if (await wasScratchReclaimed(directory)) {
      return { status: "already-reclaimed", directory };
    }
    const warning = `Backup scratch cleanup failed at ${directory}: ${formatErrorMessage(error)}. Run \`openclaw doctor --fix\` to retry cleanup.`;
    reportScratchMessage(warning, log);
    return { status: "failed", warning };
  }
}

export async function finishBackupScratch(
  scratch: BackupScratch,
  log?: (message: string) => void,
): Promise<string | undefined> {
  let retirementFailure: unknown;
  try {
    scratch.release = scratch.release.beginRetirement();
    // The exclusive token excludes readers while payload deletion makes space
    // for SQLite's retirement page/journal without a filesystem-specific reserve.
    await removeBackupScratchPayload(scratch.boundary);
    scratch.release(true);
  } catch (error) {
    retirementFailure = error;
  }
  try {
    scratch.release();
  } catch (error) {
    retirementFailure ??= error;
  }
  if (retirementFailure) {
    const warning = `Backup scratch retirement failed at ${scratch.directory}: ${formatErrorMessage(retirementFailure)}. Scratch was preserved.`;
    reportScratchMessage(warning, log);
    return warning;
  }
  const cleanup = await cleanupBackupScratchDirectory(scratch.directory, scratch.boundary, log);
  if (cleanup.status === "already-reclaimed") {
    reportScratchMessage(`Backup scratch already reclaimed: ${cleanup.directory}`, log, "info");
  }
  return cleanup.status === "failed" ? cleanup.warning : undefined;
}

/** The transaction, not age or a successful archive record, fences live scratch. */
export async function maintainBackupScratch(params: {
  roots?: readonly string[];
  repair: boolean;
  log?: (message: string) => void;
}): Promise<BackupScratchReport> {
  const report: BackupScratchReport = {
    reclaimed: [],
    alreadyReclaimed: [],
    active: [],
    unchecked: [],
    warnings: [],
  };
  const roots = new Set<string>();
  for (const root of params.roots ?? [os.tmpdir()]) {
    try {
      roots.add(await fs.realpath(root));
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        report.warnings.push(
          `Cannot inspect backup scratch in ${root}: ${formatErrorMessage(error)}`,
        );
      }
    }
  }
  for (const root of roots) {
    try {
      for (const entry of await fs.readdir(root, { withFileTypes: true })) {
        if (!scratchName.test(entry.name)) {
          continue;
        }
        const directory = path.join(root, entry.name);
        if (!entry.isDirectory()) {
          report.warnings.push(
            `Backup scratch entry preserved at ${directory}: not a directory. Inspect it before manual cleanup.`,
          );
          continue;
        }
        let release: SqliteStagingToken | undefined;
        try {
          const before = await fs.lstat(directory);
          if (!before.isDirectory() || (process.getuid && before.uid !== process.getuid())) {
            continue;
          }
          const token = await fs
            .lstat(path.join(directory, SQLITE_STAGING_TOKEN_FILES[0]))
            .catch((error: unknown) => {
              if (hasErrnoCode(error, "ENOENT")) {
                return undefined;
              }
              throw error;
            });
          const owned = entry.name.startsWith(ownedPrefix);
          // Live snapshots can remove journals while inspection awaits lstat.
          // Token-backed and newly owned repair inspect after exclusive admission below.
          if (!params.repair || (!token && !owned)) {
            await inspectScratchPayload(directory);
          }
          if (!token && !owned && !entry.name.startsWith(retiredPrefix)) {
            report.warnings.push(
              `Legacy backup scratch at ${directory} has no lifetime token. Confirm older backup processes have stopped before removing it.`,
            );
            continue;
          }
          if (!params.repair) {
            report.unchecked.push(directory);
            continue;
          }
          if (token || owned) {
            // New creators and reclaimers arbitrate the same token before payload admission.
            release = acquireSqliteStagingToken(directory, "reclaim", { allowMissing: owned });
          }
          const boundary = await createRoot(directory);
          const current = await fs.lstat(directory);
          if (
            !current.isDirectory() ||
            !sameFileIdentity(before, current) ||
            !sameFileIdentity(before, await boundary.stat("."))
          ) {
            throw new Error("Scratch directory identity changed");
          }
          await inspectScratchPayload(directory);
          await removeBackupScratchPayload(boundary);
          release?.(true);
          const cleanup = await cleanupBackupScratchDirectory(directory, boundary, () => {});
          if (cleanup.status === "failed") {
            report.warnings.push(cleanup.warning);
          } else if (cleanup.status === "already-reclaimed") {
            report.alreadyReclaimed.push(cleanup.directory);
          } else {
            report.reclaimed.push(directory);
          }
        } catch (error) {
          if (isSqliteLockError(error)) {
            report.active.push(directory);
          } else if (await wasScratchReclaimed(directory)) {
            report.alreadyReclaimed.push(directory);
          } else {
            report.warnings.push(
              `Backup scratch preserved at ${directory}: ${formatErrorMessage(error)}`,
            );
          }
        } finally {
          try {
            release?.();
          } catch (error) {
            report.warnings.push(
              `Backup scratch token release failed at ${directory}: ${formatErrorMessage(error)}`,
            );
          }
        }
      }
    } catch (error) {
      report.warnings.push(
        `Cannot inspect backup scratch in ${root}: ${formatErrorMessage(error)}`,
      );
    }
  }
  for (const warning of report.warnings) {
    reportScratchMessage(warning, params.log);
  }
  for (const directory of report.alreadyReclaimed) {
    reportScratchMessage(`Backup scratch already reclaimed: ${directory}`, params.log, "info");
  }
  return report;
}
