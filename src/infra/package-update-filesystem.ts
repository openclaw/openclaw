import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "./errors.js";
import type { createPackageIntegrityReader } from "./package-update-integrity.js";
import type { StagedPackageSwapParams } from "./package-update-swap-contract.js";
import { movePathWithCopyFallback } from "./replace-file.js";

export const PACKAGE_MANAGER_SWAP_SOURCE_HARDLINKS = "allow" as const;

export async function packagePathEntryExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

export async function packagePathEntriesMatch(left: string, right: string): Promise<boolean> {
  const [leftStat, rightStat] = await Promise.all([
    fs.lstat(left).catch(() => null),
    fs.lstat(right).catch(() => null),
  ]);
  if (!leftStat || !rightStat) {
    return false;
  }
  if (leftStat.isSymbolicLink() || rightStat.isSymbolicLink()) {
    return (
      leftStat.isSymbolicLink() &&
      rightStat.isSymbolicLink() &&
      (await fs.readlink(left)) === (await fs.readlink(right))
    );
  }
  if (!leftStat.isFile() || !rightStat.isFile()) {
    return false;
  }
  if ((leftStat.mode & 0o777) !== (rightStat.mode & 0o777) || leftStat.size !== rightStat.size) {
    return false;
  }
  const [leftContents, rightContents] = await Promise.all([fs.readFile(left), fs.readFile(right)]);
  return leftContents.equals(rightContents);
}

export async function activateStagedNpmPackageRoot(
  source: string,
  destination: string,
  assertCurrent?: () => void,
): Promise<void> {
  if (assertCurrent) {
    // A durable descriptor binds the staged inode. A copied replacement would
    // invalidate that evidence and cannot be silently admitted for recovery.
    assertCurrent();
    await fs.rename(source, destination);
    return;
  }
  const stat = await fs.lstat(source);
  if (!stat.isSymbolicLink()) {
    await movePathWithCopyFallback({
      from: source,
      sourceHardlinks: PACKAGE_MANAGER_SWAP_SOURCE_HARDLINKS,
      to: destination,
    });
    return;
  }

  // npm represents global local-directory installs as relative symlinks. Moving
  // one changes its meaning, so activate the same canonical source explicitly.
  const canonicalSource = await fs.realpath(source);
  await fs.symlink(
    canonicalSource,
    destination,
    process.platform === "win32" ? "junction" : undefined,
  );
}

export function removePackagePath(target: string, assertCurrent = () => {}): Promise<void> {
  assertCurrent();
  return fs.rm(target, {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 5 : 2,
    retryDelay: 100,
  });
}

export async function copyPackagePathEntry(
  source: string,
  destination: string,
  assertCurrent = () => {},
): Promise<void> {
  const stat = await fs.lstat(source);
  assertCurrent();
  if (stat.isDirectory()) {
    await removePackagePath(destination, assertCurrent);
    assertCurrent();
    await fs.cp(source, destination, { recursive: true, force: true, preserveTimestamps: false });
    return;
  }
  // A partial launcher cannot be reconciled as either generation. Prepare its
  // replacement beside the destination so publication leaves exact old or new bytes.
  const staging = await fs.mkdtemp(path.join(path.dirname(destination), ".openclaw-shim-stage-"));
  const staged = path.join(staging, "entry");
  try {
    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(source);
      assertCurrent();
      await fs.symlink(target, staged);
      if (process.platform === "darwin") {
        // macOS applies umask to symlinks; preserve the link, never chmod its target.
        assertCurrent();
        await fs.lchmod(staged, stat.mode);
      }
    } else {
      assertCurrent();
      await fs.copyFile(source, staged);
      assertCurrent();
      await fs.chmod(staged, stat.mode);
    }
    assertCurrent();
    await fs.rename(staged, destination);
  } finally {
    await removePackagePath(staging);
  }
}

export type PackageLauncherBackup = {
  backupDir?: string;
  entries: Array<{
    source: string;
    destination: string;
    backup: string | null;
    fingerprint?: string;
  }>;
};

/** Publish partial backup state so the swap owner can recover after any failed copy. */
export async function capturePackageLaunchers(
  snapshot: PackageLauncherBackup,
  params: Pick<StagedPackageSwapParams, "packageName" | "installTarget" | "stage">,
  targetLayout: { globalRoot: string; binDir: string },
  reader: ReturnType<typeof createPackageIntegrityReader>,
): Promise<void> {
  const native = params.stage.native;
  await fs.mkdir(targetLayout.globalRoot, { recursive: true });
  const shimNames = new Set([params.packageName, "openclaw"]);
  const shimEntries =
    params.installTarget.directNodeModulesRoot === true
      ? []
      : (
          await (
            native
              ? fs.readdir(params.stage.layout.binDir)
              : reader.entries(params.stage.layout.binDir)
          ).catch((error: unknown) => {
            if (hasErrnoCode(error, "ENOENT")) {
              return [];
            }
            throw error;
          })
        )
          .filter((entry) => shimNames.has(entry) || shimNames.has(path.parse(entry).name))
          .toSorted();
  if (shimEntries.length > 0) {
    snapshot.backupDir = await fs.mkdtemp(
      path.join(targetLayout.globalRoot, ".openclaw.shim-backup-"),
    );
    await fs.mkdir(targetLayout.binDir, { recursive: true });
    // Capture every original before moving its package; relative npm shims can
    // become dangling during the swap, and failed backup copies touch no live entry.
    for (const entry of shimEntries) {
      const destination = path.join(targetLayout.binDir, entry);
      const backup = (await (native
        ? packagePathEntryExists(destination)
        : reader.exists(destination)))
        ? path.join(snapshot.backupDir, entry)
        : null;
      const fingerprint = backup && !native ? await reader.launcher(destination) : undefined;
      if (backup) {
        await copyPackagePathEntry(destination, backup);
        if (!native && (await reader.launcher(backup)) !== fingerprint) {
          throw new Error(`Package rollback launcher backup changed: ${destination}`);
        }
      }
      snapshot.entries.push({
        source: path.join(params.stage.layout.binDir, entry),
        destination,
        backup,
        fingerprint,
      });
    }
  }
}

/** The caller verifies recovery material before this exact-object publication. */
export async function restoreNpmPackageRoot(params: {
  liveRoot: string;
  backupRoot: string;
  displacedRoot: string;
  candidatePresent: boolean;
  assertCurrent?: () => void;
}): Promise<void> {
  const assertCurrent = params.assertCurrent ?? (() => {});
  if (params.candidatePresent) {
    assertCurrent();
    await fs.rename(params.liveRoot, params.displacedRoot);
  }
  try {
    assertCurrent();
    await fs.rename(params.backupRoot, params.liveRoot);
  } catch (error) {
    // A denied rename must leave the candidate available. Never substitute a
    // copied old tree for the exact object whose identity was verified.
    assertCurrent();
    if (params.candidatePresent) {
      await fs.rename(params.displacedRoot, params.liveRoot);
    }
    throw error;
  }
}

/** Retire only obsolete backups after restoration or verified activation. */
export async function discardPackageUpdateBackup(
  backupPath: string,
  label: string,
  globalRoot: string,
  assertCurrent = () => {},
): Promise<string | null> {
  try {
    await removePackagePath(backupPath, assertCurrent);
    return null;
  } catch {
    assertCurrent();
    const retiredPath = path.join(
      globalRoot,
      path.basename(backupPath).replace(/^\.openclaw\./, ".openclaw-"),
    );
    try {
      // npm may clean the disposable namespace on a later update. Only an
      // already-obsolete backup can enter it; failure preserves the artifact.
      assertCurrent();
      await fs.rename(backupPath, retiredPath);
      return `preserved ${label} at ${retiredPath} for delayed cleanup`;
    } catch {
      assertCurrent();
      return `preserved ${label} at ${backupPath}; remove it manually after verifying the installation`;
    }
  }
}

export async function removePackageUpdatePath(targetPath: string): Promise<boolean> {
  try {
    await removePackagePath(targetPath);
    return true;
  } catch {
    return false;
  }
}
