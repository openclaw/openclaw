import fsSync, { type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { movePathWithCopyFallback } from "@openclaw/fs-safe/atomic";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { root as fsSafeRoot } from "@openclaw/fs-safe/root";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { requireDirectorySync, syncDirectory } from "./directory-durability.js";
import { ignoreMissingPath } from "./errno.js";
import { formatErrorMessage, formatErrorMessageWithCode, hasErrnoCode, isErrno } from "./errors.js";
import { isRemovalIoError, removePathWithinRoot } from "./fs-safe-remove.js";
import { retainMutationAuthority } from "./mutation-authority.js";
import type {
  createPackageIntegrityReader,
  PackageLauncherFingerprint,
} from "./package-update-integrity.js";
import type { StagedPackageSwapParams } from "./package-update-swap-contract.js";
import { pathEntryExists as packagePathEntryExists } from "./path-existence.js";
import { retryAsync } from "./retry.js";
import { UPDATE_CLEANUP_BUDGET_MS } from "./update-maintenance.js";

export const PACKAGE_MANAGER_SWAP_SOURCE_HARDLINKS = "allow" as const;
const log = createSubsystemLogger("update/package-launchers");

export function assertPackagePathIdentity(
  filePath: string,
  expected: BigIntStats | undefined,
): void {
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

export function createPackagePathAssertion(
  filePath: string,
  expected: BigIntStats,
  assertParents: () => void,
): () => void {
  return () => {
    assertParents();
    assertPackagePathIdentity(filePath, expected);
  };
}

export { packagePathEntryExists };

export async function activateStagedNpmPackageRoot(
  source: string,
  destination: string,
  assertCurrent?: () => void,
  unjournaled?: { assertCaller?: () => void; warnings: string[]; platform?: NodeJS.Platform },
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
    if (unjournaled && (unjournaled.platform ?? process.platform) === "win32") {
      // The stage is a sibling of the live root, so this rename cannot cross
      // devices. fs-safe's Windows EPERM copy fallback would instead copy the
      // tree and then fail deleting the still-held stage after publication.
      await renamePackageRootWithWindowsRetries(
        source,
        destination,
        retainMutationAuthority(unjournaled.assertCaller ?? (() => {})),
        { operation: "activation", warn: (message) => unjournaled.warnings.push(message) },
      );
      return;
    }
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

export async function backupNpmPackageRoot(
  source: string,
  destination: string,
  assertCaller: (() => void) | undefined,
  warnings: string[],
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== "win32") {
    await fs.rename(source, destination);
    return;
  }
  await renamePackageRootWithWindowsRetries(
    source,
    destination,
    retainMutationAuthority(assertCaller ?? (() => {})),
    {
      operation: "backup",
      warn: (message) => warnings.push(message),
    },
  );
}

/**
 * Shared bounded Windows retries for guarded package-root renames: transient
 * AV/indexer denials are retried with authority and path-identity checks while
 * permanent failures stay failures. Package backup, unjournaled activation, and
 * rollback publication/compensation renames share this one implementation;
 * callers keep their own operation-specific diagnostics through `operation` and `warn`.
 */
async function renamePackageRootWithWindowsRetries(
  source: string,
  destination: string,
  assertCurrent: () => void,
  options: { operation: string; warn?: (message: string) => void },
): Promise<void> {
  const sourceIdentity = fsSync.lstatSync(source, { bigint: true });
  const parent = path.dirname(source);
  const parentIdentity = fsSync.lstatSync(parent, { bigint: true });
  let renameFailure: unknown;
  let attempts = 0;
  try {
    await retryAsync(
      async () => {
        renameFailure = undefined;
        assertCurrent();
        assertPackagePathIdentity(parent, parentIdentity);
        assertPackagePathIdentity(source, sourceIdentity);
        assertPackagePathIdentity(destination, undefined);
        attempts++;
        try {
          await fs.rename(source, destination);
        } catch (error) {
          renameFailure = error;
          throw error;
        }
      },
      {
        // Windows AV/indexer handles can block directory renames for a minute.
        // These referenced waits total 57.75 seconds; never copy/delete the live tree.
        attempts: 16,
        minDelayMs: 250,
        maxDelayMs: 5_000,
        shouldRetry: (error) =>
          error === renameFailure &&
          ["EPERM", "EBUSY", "EACCES"].some((code) => hasErrnoCode(error, code)),
        onRetry: ({ err, attempt, maxAttempts, delayMs }) => {
          if (options.warn) {
            options.warn(
              `Windows package ${options.operation} rename ${source} -> ${destination} failed: ${formatErrorMessage(err)}; retry ${attempt + 1}/${maxAttempts} in ${delayMs}ms.`,
            );
          }
        },
      },
    );
  } catch (error) {
    if (error !== renameFailure) {
      throw error;
    }
    throw Object.assign(
      new Error(
        `Windows package ${options.operation} rename failed after ${attempts} attempts: ${source} -> ${destination}: ${formatErrorMessage(error)}. Close processes holding this installation and check its permissions before retrying.`,
        { cause: error },
      ),
      { code: isErrno(error) ? error.code : undefined },
    );
  }
}

export function removePackagePath(
  target: string,
  assertCurrent = () => {},
  signal?: AbortSignal,
): Promise<void> {
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
    signal,
  });
}

export async function copyPackagePathEntry(
  source: string,
  destination: string,
  assertCaller = () => {},
  beforePublish?: (staged: string) => void,
): Promise<void> {
  const assertCurrent = retainMutationAuthority(assertCaller);
  assertCurrent();
  const sourceIdentity = fsSync.lstatSync(source, { bigint: true });
  if (sourceIdentity.isDirectory() && beforePublish) {
    throw new Error("Journal-owned launcher publication requires a file or symlink.");
  }
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
  const assertStaging = createPackagePathAssertion(staging, stagingIdentity, assertParent);
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
      const assertEntry = createPackagePathAssertion(from, identity, assertParents);
      assertEntry();
      const to = path.join(staging, relativePath);
      if (identity.isDirectory()) {
        await stagedRoot.mkdir(relativePath, { assertBeforeMutation: assertEntry });
        assertEntry();
        const directoryIdentity = fsSync.lstatSync(to, { bigint: true });
        const assertDirectory = createPackagePathAssertion(to, directoryIdentity, assertEntry);
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
        const assertLink = createPackagePathAssertion(to, linkIdentity, assertEntry);
        if (nested) {
          if (process.platform === "darwin") {
            assertLink();
            await fs.lchmod(to, Number(identity.mode));
            assertLink();
          }
        } else {
          // Launcher metadata is best effort, but must never follow its target.
          const ownership = destinationIdentity?.isSymbolicLink() ? destinationIdentity : identity;
          const preserveOwnership = async () => {
            try {
              await fs.lchown(to, Number(ownership.uid), Number(ownership.gid));
            } catch (error) {
              if (
                (!hasErrnoCode(error, "EPERM") && !hasErrnoCode(error, "EACCES")) ||
                !process.geteuid ||
                !process.getegid
              ) {
                throw error;
              }
              // macOS inherits the bin directory's group even for a non-root
              // updater. Do not leave that unrepeatable ownership on a new link.
              assertLink();
              await fs.lchown(to, process.geteuid(), process.getegid());
              log.warn(
                `Could not preserve launcher symlink ownership from ${source}; using updater ownership`,
              );
            }
          };
          for (const [field, preserve] of [
            ["ownership", preserveOwnership],
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
          // Journal publication performs its own strict sync below; ordinary
          // copies retain fs-safe's best-effort durability.
          durable: !beforePublish,
        });
      } else {
        throw new Error(`Unsupported package entry: ${from}`);
      }
      assertEntry();
    };
    await copyEntry(source, "entry", sourceIdentity, assertStaging, false);
    assertStaging();
    const stagedIdentity = fsSync.lstatSync(staged, { bigint: true });
    if (beforePublish && sourceIdentity.isFile()) {
      const opened = await stagedRoot.open("entry");
      try {
        assertStaging();
        assertPackagePathIdentity(staged, stagedIdentity);
        const openedIdentity = fsSync.fstatSync(opened.handle.fd, { bigint: true });
        if (
          openedIdentity.dev !== stagedIdentity.dev ||
          openedIdentity.ino !== stagedIdentity.ino
        ) {
          throw new FsSafeError("path-mismatch", "staged package launcher changed before sync");
        }
        await opened.handle.sync();
        assertStaging();
        assertPackagePathIdentity(staged, stagedIdentity);
      } finally {
        await opened.handle.close();
      }
    }
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
    if (beforePublish) {
      // Also persist symlink entries, whose branch does not use copyIn.
      requireDirectorySync(await syncDirectory(staging), "Staged package launcher");
      assertStaging();
      assertPackagePathIdentity(staged, stagedIdentity);
      assertPackagePathIdentity(target, destinationIdentity);
    }
    beforePublish?.(staged);
    assertStaging();
    assertPackagePathIdentity(staged, stagedIdentity);
    assertPackagePathIdentity(target, destinationIdentity);
    await fs.rename(staged, target);
    assertParent();
    if (beforePublish) {
      for (const directory of [staging, destinationParent]) {
        assertStaging();
        assertPackagePathIdentity(target, stagedIdentity);
        requireDirectorySync(await syncDirectory(directory), "Package launcher publication");
        assertStaging();
        assertPackagePathIdentity(target, stagedIdentity);
      }
    }
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
}

export type PackageLauncherBackup = {
  backupDir?: string;
  entries: Array<{
    source: string;
    destination: string;
    backup: string | null;
    fingerprint?: PackageLauncherFingerprint;
  }>;
};

export function resolvePackageUpdateLauncherNames(
  packageName: string,
  entries?: readonly string[],
) {
  const names = new Set([packageName, "openclaw"]);
  return (
    entries?.filter((entry) => names.has(entry) || names.has(path.parse(entry).name)) ?? [...names]
  ).toSorted();
}

/** Publish partial backup state so the swap owner can recover after any failed copy. */
export async function capturePackageLaunchers(
  snapshot: PackageLauncherBackup,
  params: Pick<StagedPackageSwapParams, "packageName" | "installTarget" | "stage">,
  targetLayout: { globalRoot: string; binDir: string },
  reader: ReturnType<typeof createPackageIntegrityReader>,
): Promise<void> {
  const native = params.stage.native;
  await fs.mkdir(targetLayout.globalRoot, { recursive: true });
  const shimEntries =
    params.installTarget.directNodeModulesRoot === true
      ? []
      : resolvePackageUpdateLauncherNames(
          params.packageName,
          await (
            native
              ? fs.readdir(params.stage.layout.binDir)
              : reader.entries(params.stage.layout.binDir)
          ).catch((error: unknown) => ignoreMissingPath(error) ?? []),
        );
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
  platform?: NodeJS.Platform;
}): Promise<void> {
  const assertCurrent = retainMutationAuthority(params.assertCurrent ?? (() => {}));
  const restoreRename =
    (params.platform ?? process.platform) === "win32"
      ? (from: string, to: string) =>
          renamePackageRootWithWindowsRetries(from, to, assertCurrent, { operation: "restore" })
      : (from: string, to: string) => fs.rename(from, to);
  if (params.candidatePresent) {
    assertCurrent();
    await restoreRename(params.liveRoot, params.displacedRoot);
  }
  try {
    assertCurrent();
    await restoreRename(params.backupRoot, params.liveRoot);
  } catch (error) {
    // A denied rename must leave the candidate available. Never substitute a
    // copied old tree for the exact object whose identity was verified.
    assertCurrent();
    if (params.candidatePresent) {
      try {
        await restoreRename(params.displacedRoot, params.liveRoot);
      } catch (compensationError) {
        assertCurrent();
        if (await packagePathEntryExists(params.liveRoot)) {
          throw compensationError;
        }
        throw new Error(
          `${formatErrorMessage(compensationError)}; ${params.liveRoot} is missing. Restore a bootable installation by moving ${params.backupRoot} (the previous package) or ${params.displacedRoot} (the rejected update) to ${params.liveRoot} after closing processes that hold them.`,
          { cause: compensationError },
        );
      }
    } else if (!(await packagePathEntryExists(params.liveRoot))) {
      assertCurrent();
      throw new Error(
        `${formatErrorMessage(error)}; ${params.liveRoot} is missing. Restore the previous package by moving ${params.backupRoot} to ${params.liveRoot} after closing processes that hold it.`,
        { cause: error },
      );
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
  cleanupDeadlineAtMs = performance.now() + UPDATE_CLEANUP_BUDGET_MS,
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
  const cleanupExpired = new Error("Obsolete backup cleanup budget expired");
  const cleanup = new AbortController();
  try {
    // Stop further retirement work at its next custody check, but join every
    // pending filesystem operation before reporting retained material.
    await removePackagePath(
      backup,
      () => {
        assertBackup();
        if (performance.now() >= cleanupDeadlineAtMs) {
          // Revalidation must preserve filesystem errors; abort only at removal dispatch.
          cleanup.abort(cleanupExpired);
        }
      },
      cleanup.signal,
    );
    return null;
  } catch (error) {
    assertBackup();
    // A path/authority refusal is not an ordinary obsolete-backup cleanup error.
    // Keep it at its original name instead of moving unowned bytes to retirement.
    if (error !== cleanupExpired && !isRemovalIoError(error)) {
      throw error;
    }
    const expiredMessage = `cleanup budget expired after ${UPDATE_CLEANUP_BUDGET_MS}ms; preserved ${label} at ${backupPath} for delayed cleanup${error === cleanupExpired ? "" : `; ${formatErrorMessage(error)}`}`;
    if (error === cleanupExpired || performance.now() >= cleanupDeadlineAtMs) {
      return fsSync.lstatSync(backup, { throwIfNoEntry: false }) ? expiredMessage : null;
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
      if (performance.now() >= cleanupDeadlineAtMs) {
        return expiredMessage;
      }
      await fs.rename(backup, retiredPath);
      assertParents();
      assertPackagePathIdentity(retiredPath, backupIdentity);
      return `preserved ${label} at ${retiredPath} for delayed cleanup: ${formatErrorMessageWithCode(error)}`;
    } catch (retirementError) {
      assertBackup();
      assertPackagePathIdentity(backup, backupIdentity);
      if (!isRemovalIoError(retirementError)) {
        throw retirementError;
      }
      return `preserved ${label} at ${backupPath}; removal failed: ${formatErrorMessageWithCode(error)}; retirement rename failed: ${formatErrorMessageWithCode(retirementError)}; remove it manually after verifying the installation`;
    }
  }
}

export async function discardPackageLauncherBackup(
  snapshot: PackageLauncherBackup,
  globalRoot: string,
  assertCurrent?: () => void,
  cleanupDeadlineAtMs?: number,
): Promise<string | null> {
  return snapshot.backupDir
    ? await discardPackageUpdateBackup(
        snapshot.backupDir,
        "shim backup",
        globalRoot,
        assertCurrent,
        cleanupDeadlineAtMs,
      )
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
