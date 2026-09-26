import fsSync, { type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { movePathWithCopyFallback } from "@openclaw/fs-safe/atomic";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { root as fsSafeRoot } from "@openclaw/fs-safe/root";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { hasErrnoCode } from "./errors.js";
import { isRemovalIoError, removePathWithinRoot } from "./fs-safe-remove.js";
import { retainMutationAuthority } from "./mutation-authority.js";
import {
  type createPackageIntegrityReader,
  type PackageLauncherFingerprint,
  packageLauncherDifferences,
} from "./package-update-integrity.js";
import type { StagedPackageSwapParams } from "./package-update-swap-contract.js";

export const PACKAGE_MANAGER_SWAP_SOURCE_HARDLINKS = "allow" as const;
const log = createSubsystemLogger("update/package-launchers");

function assertPackagePathIdentity(filePath: string, expected: BigIntStats | undefined): void {
  let current: BigIntStats | undefined;
  try {
    current = fsSync.lstatSync(filePath, { bigint: true, throwIfNoEntry: false });
  } catch (cause) {
    throw new FsSafeError("path-mismatch", `package path could not be verified: ${filePath}`, {
      cause: cause instanceof Error ? cause : undefined,
    });
  }
  if (
    expected
      ? !current ||
        current.dev !== expected.dev ||
        current.ino !== expected.ino ||
        current.isDirectory() !== expected.isDirectory() ||
        current.isSymbolicLink() !== expected.isSymbolicLink() ||
        (process.platform === "win32" &&
          (current.dev === 0n || current.ino === 0n || expected.dev === 0n || expected.ino === 0n))
      : current !== undefined
  ) {
    throw new FsSafeError("path-mismatch", `package path changed: ${filePath}`);
  }
}

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
    const assertOwner = retainMutationAuthority(assertCurrent);
    assertOwner();
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
  const assertOwner = retainMutationAuthority(assertCurrent);
  assertOwner();
  if (!fsSync.lstatSync(target, { throwIfNoEntry: false })) {
    return Promise.resolve();
  }
  return removePathWithinRoot({
    rootDir: path.dirname(target),
    relativePath: path.basename(target),
    recursive: true,
    force: true,
    symlinks: "unlink",
    assertBeforeMutation: assertOwner,
  });
}

export async function copyPackagePathEntry(
  source: string,
  destination: string,
  assertCaller = () => {},
): Promise<{ ownershipPreserved: boolean }> {
  const assertCurrent = retainMutationAuthority(assertCaller);
  assertCurrent();
  const sourceIdentity = fsSync.lstatSync(source, { bigint: true });
  const destinationParent = await fs.realpath(path.dirname(destination));
  assertCurrent();
  const parentIdentity = fsSync.lstatSync(destinationParent, { bigint: true });
  if (!parentIdentity.isDirectory() || parentIdentity.isSymbolicLink()) {
    throw new FsSafeError("path-mismatch", "package destination parent changed");
  }
  const target = path.join(destinationParent, path.basename(destination));
  let destinationIdentity = fsSync.lstatSync(target, { bigint: true, throwIfNoEntry: false });
  const assertParent = retainMutationAuthority(() => {
    assertCurrent();
    assertPackagePathIdentity(destinationParent, parentIdentity);
  });
  // Prepare complete files and directories privately. Even fs-safe's native copy
  // can finish metadata after publication; none of that may touch a live launcher.
  assertParent();
  const staging = await fs.mkdtemp(path.join(destinationParent, ".openclaw-shim-stage-"));
  const stagingIdentity = fsSync.lstatSync(staging, { bigint: true });
  const staged = path.join(staging, "entry");
  const assertStaging = () => {
    assertParent();
    assertPackagePathIdentity(staging, stagingIdentity);
  };
  let ownershipPreserved = true;
  let failure: { error: unknown } | undefined;
  try {
    const stagedRoot = await fsSafeRoot(staging, { assertBeforeMutation: assertStaging });
    assertStaging();
    const copyEntry = async (
      from: string,
      relativePath: string,
      identity: BigIntStats,
      assertParents: () => void,
      nested: boolean,
    ): Promise<void> => {
      const assertEntry = () => {
        assertParents();
        assertPackagePathIdentity(from, identity);
      };
      assertEntry();
      const to = path.join(staging, relativePath);
      if (identity.isDirectory()) {
        await stagedRoot.mkdir(relativePath, { assertBeforeMutation: assertEntry });
        assertEntry();
        const directoryIdentity = fsSync.lstatSync(to, { bigint: true });
        const assertDirectory = () => {
          assertEntry();
          assertPackagePathIdentity(to, directoryIdentity);
        };
        const names = (await fs.readdir(from)).toSorted();
        assertDirectory();
        const children = names.map((name) => ({
          name,
          identity: fsSync.lstatSync(path.join(from, name), { bigint: true }),
        }));
        for (const child of children) {
          await copyEntry(
            path.join(from, child.name),
            path.join(relativePath, child.name),
            child.identity,
            assertDirectory,
            true,
          );
        }
        assertDirectory();
        await fs.chmod(to, Number(identity.mode));
      } else if (identity.isSymbolicLink()) {
        let linkTarget = await fs.readlink(from);
        assertEntry();
        // Match fs.cp's directory-tree links; standalone launcher links keep
        // their authored spelling because they return to their original location.
        if (nested && !path.isAbsolute(linkTarget)) {
          linkTarget = path.resolve(path.dirname(from), linkTarget);
        }
        await fs.symlink(linkTarget, to);
        assertEntry();
        const linkIdentity = fsSync.lstatSync(to, { bigint: true });
        const assertLink = () => {
          assertEntry();
          assertPackagePathIdentity(to, linkIdentity);
        };
        if (nested) {
          if (process.platform === "darwin") {
            assertLink();
            await fs.lchmod(to, Number(identity.mode));
            assertLink();
          }
        } else {
          // Launcher metadata is best effort, but must never follow its target.
          for (const [field, preserve] of [
            ["ownership", () => fs.lchown(to, Number(identity.uid), Number(identity.gid))],
            ...(process.platform === "darwin"
              ? ([["mode", () => fs.lchmod(to, Number(identity.mode))]] as const)
              : []),
          ] as const) {
            assertLink();
            try {
              await preserve();
            } catch (error) {
              assertLink();
              if (
                !["EPERM", "EACCES", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].some((code) =>
                  hasErrnoCode(error, code),
                )
              ) {
                throw error;
              }
              ownershipPreserved &&= field !== "ownership";
              log.warn(
                `Could not preserve launcher symlink ${field} from ${source}; continuing with the copied link`,
              );
            }
            assertLink();
          }
        }
      } else if (identity.isFile()) {
        await stagedRoot.copyIn(relativePath, from, {
          assertBeforeMutation: assertEntry,
          sourceHardlinks: PACKAGE_MANAGER_SWAP_SOURCE_HARDLINKS,
          preserveSourceMode: true,
          mkdir: false,
          durable: false,
        });
      } else {
        throw new Error(`Unsupported package entry: ${from}`);
      }
      assertEntry();
    };
    await copyEntry(source, "entry", sourceIdentity, assertStaging, false);
    assertStaging();
    const stagedIdentity = fsSync.lstatSync(staged, { bigint: true });
    assertPackagePathIdentity(target, destinationIdentity);
    if (sourceIdentity.isDirectory()) {
      await removePackagePath(
        target,
        retainMutationAuthority(() => {
          assertStaging();
          // The last owned unlink may already have removed the target. Missing
          // is safe here; replacing it with a different object is never safe.
          if (fsSync.lstatSync(target, { throwIfNoEntry: false })) {
            assertPackagePathIdentity(target, destinationIdentity);
          }
        }),
      );
      destinationIdentity = undefined;
    }
    assertStaging();
    assertPackagePathIdentity(staged, stagedIdentity);
    assertPackagePathIdentity(target, destinationIdentity);
    await fs.rename(staged, target);
    assertParent();
  } catch (error) {
    failure = { error };
  } finally {
    try {
      await removePackagePath(staging, () => {
        // Private cleanup keeps its captured objects, not the now-revoked or
        // successor update lease. It cannot adopt a replacement staging tree.
        assertPackagePathIdentity(destinationParent, parentIdentity);
        if (fsSync.lstatSync(staging, { throwIfNoEntry: false })) {
          assertPackagePathIdentity(staging, stagingIdentity);
        }
      });
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) {
    throw failure.error;
  }
  return { ownershipPreserved };
}

export type PackageLauncherBackup = {
  backupDir?: string;
  failedCopy?: string;
  entries: Array<{
    source: string;
    destination: string;
    backup: string | null;
    fingerprint?: PackageLauncherFingerprint;
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
      let fingerprint = backup && !native ? await reader.launcher(destination) : undefined;
      if (backup) {
        const copied = await copyPackagePathEntry(destination, backup);
        if (fingerprint) {
          // Keep failed verification evidence even when activation never starts.
          snapshot.failedCopy = backup;
          const actual = await reader.launcher(backup);
          const differences = packageLauncherDifferences(
            fingerprint,
            actual,
            copied.ownershipPreserved,
          );
          if (differences.length > 0) {
            throw new Error(
              `Package rollback launcher backup changed: ${destination}; differing fields: ${differences.join(", ")}`,
            );
          }
          snapshot.failedCopy = undefined;
          fingerprint = actual;
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
  const assertCurrent = retainMutationAuthority(params.assertCurrent ?? (() => {}));
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
  assertCaller = () => {},
): Promise<string | null> {
  const assertCurrent = retainMutationAuthority(assertCaller);
  assertCurrent();
  const backupIdentity = fsSync.lstatSync(backupPath, { bigint: true, throwIfNoEntry: false });
  if (!backupIdentity) {
    return null;
  }
  const backupParent = fsSync.realpathSync(path.dirname(backupPath));
  const retiredParent = fsSync.realpathSync(globalRoot);
  const parents = [backupParent, retiredParent].map((directory) => ({
    directory,
    identity: fsSync.lstatSync(directory, { bigint: true }),
  }));
  const backup = path.join(backupParent, path.basename(backupPath));
  const assertParents = retainMutationAuthority(() => {
    assertCurrent();
    for (const { directory, identity } of parents) {
      assertPackagePathIdentity(directory, identity);
    }
  });
  const assertBackup = retainMutationAuthority(() => {
    assertParents();
    if (fsSync.lstatSync(backup, { throwIfNoEntry: false })) {
      assertPackagePathIdentity(backup, backupIdentity);
    }
  });
  try {
    await removePackagePath(backup, assertBackup);
    return null;
  } catch (error) {
    assertBackup();
    // A path/authority refusal is not an ordinary obsolete-backup cleanup error.
    // Keep it at its original name instead of moving unowned bytes to retirement.
    if (!isRemovalIoError(error)) {
      throw error;
    }
    const retiredPath = path.join(
      retiredParent,
      path.basename(backupPath).replace(/^\.openclaw\./, ".openclaw-"),
    );
    try {
      // npm may clean the disposable namespace on a later update. Only an
      // already-obsolete captured object can enter it, never a replacement.
      assertBackup();
      assertPackagePathIdentity(backup, backupIdentity);
      assertPackagePathIdentity(retiredPath, undefined);
      await fs.rename(backup, retiredPath);
      assertParents();
      assertPackagePathIdentity(retiredPath, backupIdentity);
      return `preserved ${label} at ${retiredPath} for delayed cleanup`;
    } catch (retirementError) {
      assertBackup();
      assertPackagePathIdentity(backup, backupIdentity);
      if (!isRemovalIoError(retirementError)) {
        throw retirementError;
      }
      return `preserved ${label} at ${backupPath}; remove it manually after verifying the installation`;
    }
  }
}

export async function discardPackageLauncherBackup(
  snapshot: PackageLauncherBackup,
  globalRoot: string,
  assertCurrent?: () => void,
): Promise<string | null> {
  if (snapshot.failedCopy) {
    return `failed copy retained at ${snapshot.failedCopy}; inspect it before retrying`;
  }
  return snapshot.backupDir
    ? await discardPackageUpdateBackup(snapshot.backupDir, "shim backup", globalRoot, assertCurrent)
    : null;
}

export async function removePackageUpdatePath(targetPath: string): Promise<boolean> {
  try {
    await removePackagePath(targetPath);
    return true;
  } catch {
    return false;
  }
}
