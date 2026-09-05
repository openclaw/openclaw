// Installs package directories under canonical plugin roots.
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord as isObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { runCommandWithTimeout } from "../process/exec.js";
import { hasErrnoCode } from "./errno.js";
import { pathExists } from "./fs-safe.js";
import { assertCanonicalPathWithinBase } from "./install-safe-path.js";
import { formatNpmCommandFailureOutput } from "./install-source-utils.js";
import { tryReadJson, writeJson } from "./json-files.js";
import { movePathWithCopyFallback } from "./replace-file.js";
import { createSafeNpmInstallArgs, createSafeNpmInstallEnv } from "./safe-package-install.js";

type InstallSourceHardlinks = "package-manager" | "reject";

const DEFAULT_INSTALL_SOURCE_HARDLINKS: InstallSourceHardlinks = "reject";
const INSTALL_BASE_CHANGED_ERROR_MESSAGE = "install base directory changed during install";
const INSTALL_BASE_CHANGED_ABORT_WARNING =
  "Install base directory changed during install; aborting staged publish.";
const INSTALL_BASE_CHANGED_BACKUP_WARNING =
  "Install base directory changed before backup cleanup; leaving backup in place.";
const STAGED_NPM_PROJECT_CONFIG_NAME = ".npmrc";
const STAGED_NPM_PROJECT_CONFIG_PREFIX = ".openclaw-install-hidden-npmrc-";

type HiddenProjectConfigFile = {
  hiddenDir: string;
  originalPath: string;
  hiddenPath: string;
} | null;

type InstallPackageDirFailure = { ok: false; error: string };
type InstallPackageDirSuccess = { ok: true };

export function hasPackageRuntimeDependencies(manifest: {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}): boolean {
  return (
    Object.keys(manifest.dependencies ?? {}).length > 0 ||
    Object.keys(manifest.optionalDependencies ?? {}).length > 0
  );
}

async function sanitizeManifestForNpmInstall(targetDir: string): Promise<void> {
  const manifestPath = path.join(targetDir, "package.json");
  const parsed = await tryReadJson<unknown>(manifestPath);
  if (!isObjectRecord(parsed)) {
    return;
  }
  const manifest = parsed;

  const devDependencies = manifest.devDependencies;
  if (!isObjectRecord(devDependencies)) {
    return;
  }

  const filteredEntries = Object.entries(devDependencies).filter(([, rawSpec]) => {
    const spec = typeof rawSpec === "string" ? rawSpec.trim() : "";
    return !spec.startsWith("workspace:");
  });
  if (filteredEntries.length === Object.keys(devDependencies).length) {
    return;
  }

  if (filteredEntries.length === 0) {
    delete manifest.devDependencies;
  } else {
    manifest.devDependencies = Object.fromEntries(filteredEntries);
  }
  await writeJson(manifestPath, manifest, { trailingNewline: true });
}

async function hideProjectNpmConfigForInstall(targetDir: string): Promise<HiddenProjectConfigFile> {
  const originalPath = path.join(targetDir, STAGED_NPM_PROJECT_CONFIG_NAME);
  let hiddenDir = "";
  try {
    hiddenDir = await fs.mkdtemp(path.join(targetDir, STAGED_NPM_PROJECT_CONFIG_PREFIX));
    const hiddenPath = path.join(hiddenDir, STAGED_NPM_PROJECT_CONFIG_NAME);
    await fs.rename(originalPath, hiddenPath);
    return { hiddenDir, originalPath, hiddenPath };
  } catch (error) {
    if (hiddenDir) {
      await fs.rm(hiddenDir, { recursive: true, force: true }).catch(() => undefined);
    }
    if (hasErrnoCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

async function restoreProjectNpmConfigAfterInstall(
  hiddenConfig: HiddenProjectConfigFile,
): Promise<void> {
  if (!hiddenConfig) {
    return;
  }
  await fs.rename(hiddenConfig.hiddenPath, hiddenConfig.originalPath);
  await fs.rm(hiddenConfig.hiddenDir, { recursive: true, force: true });
}

async function assertInstallBoundaryPaths(params: {
  installBaseDir: string;
  candidatePaths: string[];
}): Promise<void> {
  for (const candidatePath of params.candidatePaths) {
    await assertCanonicalPathWithinBase({
      baseDir: params.installBaseDir,
      candidatePath,
      boundaryLabel: "install directory",
    });
  }
}

function isRelativePathInsideBase(relativePath: string): boolean {
  return (
    Boolean(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`)
  );
}

function isInstallBaseChangedError(error: unknown): boolean {
  return error instanceof Error && error.message === INSTALL_BASE_CHANGED_ERROR_MESSAGE;
}

function resolveMoveSourceHardlinks(policy: InstallSourceHardlinks): "allow" | "reject" {
  return policy === "package-manager" ? "allow" : "reject";
}

async function assertInstallBaseStable(params: {
  installBaseDir: string;
  expectedRealPath: string;
}): Promise<void> {
  const baseStat = await fs.stat(params.installBaseDir);
  if (!baseStat.isDirectory()) {
    throw new Error(INSTALL_BASE_CHANGED_ERROR_MESSAGE);
  }
  const currentRealPath = await fs.realpath(params.installBaseDir);
  if (currentRealPath !== params.expectedRealPath) {
    throw new Error(INSTALL_BASE_CHANGED_ERROR_MESSAGE);
  }
}

async function cleanupInstallTempDir(dirPath: string | null): Promise<void> {
  if (!dirPath) {
    return;
  }
  await fs.rm(dirPath, { recursive: true, force: true }).catch(() => undefined);
}

async function resolveInstallPublishTarget(params: {
  installBaseDir: string;
  targetDir: string;
}): Promise<{ installBaseRealPath: string; canonicalTargetDir: string }> {
  const installBaseResolved = path.resolve(params.installBaseDir);
  const targetResolved = path.resolve(params.targetDir);
  const targetRelativePath = path.relative(installBaseResolved, targetResolved);
  if (!isRelativePathInsideBase(targetRelativePath)) {
    throw new Error("invalid install target path");
  }
  const installBaseRealPath = await fs.realpath(params.installBaseDir);
  return {
    installBaseRealPath,
    canonicalTargetDir: path.join(installBaseRealPath, targetRelativePath),
  };
}

export type PackageDirInstallTransaction = {
  commit(): Promise<void>;
  rollback(): Promise<void>;
};

type PackageDirInstallTransactionRequest = {
  assertOwned?: () => void;
};

const PACKAGE_DIR_INSTALL_TRANSACTION = Symbol.for("openclaw.packageDirInstallTransaction");
const PACKAGE_DIR_INSTALL_TRANSACTION_REQUEST = Symbol.for(
  "openclaw.packageDirInstallTransactionRequest",
);

export function requestDeferredPackageDirInstall<T extends object>(
  params: T,
  assertOwned?: () => void,
): T {
  Object.defineProperty(params, PACKAGE_DIR_INSTALL_TRANSACTION_REQUEST, {
    configurable: false,
    enumerable: true,
    value: { assertOwned } satisfies PackageDirInstallTransactionRequest,
  });
  return params;
}

export function copyPackageDirInstallTransactionRequest<T extends object>(
  source: object,
  target: T,
): T {
  const request = resolvePackageDirInstallTransactionRequest(source);
  return request ? requestDeferredPackageDirInstall(target, request.assertOwned) : target;
}

function resolvePackageDirInstallTransactionRequest(
  params: object,
): PackageDirInstallTransactionRequest | undefined {
  return (
    params as {
      [PACKAGE_DIR_INSTALL_TRANSACTION_REQUEST]?: PackageDirInstallTransactionRequest;
    }
  )[PACKAGE_DIR_INSTALL_TRANSACTION_REQUEST];
}

function attachPackageDirInstallTransaction<T extends object>(
  result: T,
  transaction: PackageDirInstallTransaction,
): T {
  Object.defineProperty(result, PACKAGE_DIR_INSTALL_TRANSACTION, {
    configurable: false,
    enumerable: true,
    value: transaction,
  });
  return result;
}

export function resolvePackageDirInstallTransaction(
  result: object,
): PackageDirInstallTransaction | undefined {
  return (result as { [PACKAGE_DIR_INSTALL_TRANSACTION]?: PackageDirInstallTransaction })[
    PACKAGE_DIR_INSTALL_TRANSACTION
  ];
}

type InstallPackageDirParams<TAfterInstallResult> = {
  sourceDir: string;
  targetDir: string;
  mode: "install" | "update";
  timeoutMs: number;
  logger?: { info?: (message: string) => void; warn?: (message: string) => void };
  copyErrorPrefix: string;
  hasDeps: boolean;
  sourceHardlinks?: InstallSourceHardlinks;
  copyFilter?: (source: string, destination: string) => boolean | Promise<boolean>;
  depsLogMessage: string;
  afterCopy?: (installedDir: string) => void | Promise<void>;
  afterInstall?: (installedDir: string) => Promise<TAfterInstallResult>;
  afterBackup?: (backupDir: string) => Promise<InstallPackageDirSuccess | InstallPackageDirFailure>;
  beforePersistentApply?: () => void;
};

/** Publishes a staged package directory and retains its validation result. */
export function installPackageDir<
  TResult extends InstallPackageDirSuccess | InstallPackageDirFailure,
>(
  params: InstallPackageDirParams<TResult> & {
    afterInstall: (installedDir: string) => Promise<TResult>;
  },
): Promise<TResult | InstallPackageDirFailure>;
export function installPackageDir<
  TFailure extends InstallPackageDirFailure = InstallPackageDirFailure,
>(
  params: InstallPackageDirParams<InstallPackageDirSuccess | TFailure>,
): Promise<InstallPackageDirSuccess | InstallPackageDirFailure | TFailure>;
export async function installPackageDir<
  TResult extends InstallPackageDirSuccess | InstallPackageDirFailure,
>(
  params: InstallPackageDirParams<TResult>,
): Promise<InstallPackageDirSuccess | InstallPackageDirFailure | TResult> {
  const transactionRequest = resolvePackageDirInstallTransactionRequest(params);
  const deferCommit = transactionRequest !== undefined;
  // Retained transactions keep their original lease, even inside a successor's async context.
  const assertOwned = transactionRequest?.assertOwned;
  const assertPersistentApply = () => {
    params.beforePersistentApply?.();
    assertOwned?.();
  };
  params.logger?.info?.(`Installing to ${params.targetDir}…`);
  const installBaseDir = path.dirname(params.targetDir);
  let initialInstallBaseRealPath: string;
  try {
    await fs.mkdir(installBaseDir, { recursive: true });
    initialInstallBaseRealPath = await fs.realpath(installBaseDir);
    await assertInstallBoundaryPaths({
      installBaseDir,
      candidatePaths: [params.targetDir],
    });
  } catch (err) {
    return { ok: false, error: `${params.copyErrorPrefix}: ${String(err)}` };
  }
  let installBaseRealPath: string;
  let canonicalTargetDir: string;
  try {
    ({ installBaseRealPath, canonicalTargetDir } = await resolveInstallPublishTarget({
      installBaseDir,
      targetDir: params.targetDir,
    }));
    if (installBaseRealPath !== initialInstallBaseRealPath) {
      throw new Error(INSTALL_BASE_CHANGED_ERROR_MESSAGE);
    }
  } catch (err) {
    if (isInstallBaseChangedError(err)) {
      params.logger?.warn?.(INSTALL_BASE_CHANGED_ABORT_WARNING);
    }
    return { ok: false, error: `${params.copyErrorPrefix}: ${String(err)}` };
  }

  const baseIdentity = fsSync.lstatSync(installBaseRealPath, { bigint: true });
  const assertDirectoryIdentity = (directory: string, identity: fsSync.BigIntStats) => {
    const current = fsSync.lstatSync(directory, { bigint: true });
    // Windows can report unknown zero identities; they cannot authorize a path mutation.
    const identityKnown =
      process.platform !== "win32" ||
      (current.dev !== 0n && current.ino !== 0n && identity.dev !== 0n && identity.ino !== 0n);
    if (
      !current.isDirectory() ||
      !identityKnown ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino
    ) {
      throw new Error(`install directory changed: ${directory}`);
    }
  };
  const assertRestoreAllowed = () => {
    assertDirectoryIdentity(installBaseRealPath, baseIdentity);
    if (fsSync.lstatSync(canonicalTargetDir, { throwIfNoEntry: false })) {
      throw new Error(`install target changed during rollback: ${canonicalTargetDir}`);
    }
    assertOwned?.();
  };

  let stageDir: string | null = null;
  let backup: { path: string; sourceHardlinks: "allow" | "reject" } | null = null;
  const sourceHardlinks = resolveMoveSourceHardlinks(
    params.sourceHardlinks ?? DEFAULT_INSTALL_SOURCE_HARDLINKS,
  );
  const fail = async (error: string, cause?: unknown) => {
    const installBaseChanged = isInstallBaseChangedError(cause);
    let restoreError: string | undefined;
    if (installBaseChanged) {
      params.logger?.warn?.(INSTALL_BASE_CHANGED_ABORT_WARNING);
    } else {
      try {
        await restoreBackup();
      } catch (restoreFailure) {
        restoreError = String(restoreFailure);
      }
      if (stageDir) {
        await cleanupInstallTempDir(stageDir);
        stageDir = null;
      }
    }
    return {
      ok: false as const,
      error: restoreError ? `${error}; could not restore existing install: ${restoreError}` : error,
    };
  };
  const restoreBackup = async (): Promise<void> => {
    if (!backup) {
      return;
    }
    const restoring = backup;
    try {
      await movePathWithCopyFallback({
        assertBeforeRename: assertRestoreAllowed,
        from: restoring.path,
        sourceHardlinks: restoring.sourceHardlinks,
        to: canonicalTargetDir,
      });
      backup = null;
    } catch (error) {
      throw new Error(`${String(error)}; backup retained at ${restoring.path}`, { cause: error });
    }
  };

  try {
    await assertInstallBoundaryPaths({
      installBaseDir: installBaseRealPath,
      candidatePaths: [canonicalTargetDir],
    });
    stageDir = await fs.mkdtemp(path.join(installBaseRealPath, ".openclaw-install-stage-"));
    await fs.cp(params.sourceDir, stageDir, {
      recursive: true,
      // Keep relative symlinks relative to the staged copy. Node's default
      // rewrites them toward the source tree, which makes valid vendored
      // package links look like install-root escapes during post-copy scans.
      verbatimSymlinks: true,
      filter: params.copyFilter,
    });
  } catch (err) {
    return await fail(`${params.copyErrorPrefix}: ${String(err)}`, err);
  }

  try {
    await params.afterCopy?.(stageDir);
  } catch (err) {
    return await fail(`post-copy validation failed: ${String(err)}`, err);
  }

  if (params.hasDeps) {
    try {
      await sanitizeManifestForNpmInstall(stageDir);
      const hiddenProjectNpmConfig = await hideProjectNpmConfigForInstall(stageDir);
      params.logger?.info?.(params.depsLogMessage);
      const npmRes = await (async () => {
        try {
          return await runCommandWithTimeout(
            // Plugins install into isolated directories, so omitting peer deps can strip
            // runtime requirements that npm would otherwise materialize for the package.
            // Verified on Blacksmith Ubuntu/Node 24/npm 11: `--silent` can make npm fail
            // with empty stdout/stderr for bad specs like `workspace:^`; `--loglevel=error`
            // stays quiet on success while preserving the actionable npm failure text.
            ["npm", ...createSafeNpmInstallArgs({ omitDev: true, loglevel: "error" })],
            {
              timeoutMs: Math.max(params.timeoutMs, 300_000),
              cwd: stageDir,
              env: createSafeNpmInstallEnv(process.env, { npmConfigCwd: stageDir }),
            },
          );
        } finally {
          await restoreProjectNpmConfigAfterInstall(hiddenProjectNpmConfig);
        }
      })();
      if (npmRes.code !== 0) {
        return await fail(`npm install failed: ${formatNpmCommandFailureOutput(npmRes)}`);
      }
    } catch (error) {
      return await fail(`npm install failed: ${String(error)}`, error);
    }
  }

  let postInstallResult: InstallPackageDirSuccess | TResult = { ok: true };
  if (params.afterInstall) {
    try {
      postInstallResult = await params.afterInstall(stageDir);
      if (!postInstallResult.ok) {
        const failed = await fail(postInstallResult.error);
        return { ...postInstallResult, error: failed.error };
      }
    } catch (err) {
      return await fail(`post-install validation failed: ${String(err)}`, err);
    }
  }

  if (params.mode === "update" && (await pathExists(canonicalTargetDir))) {
    const backupRoot = path.join(installBaseRealPath, ".openclaw-install-backups");
    const backupPath = path.join(
      backupRoot,
      `${path.basename(canonicalTargetDir)}-${randomUUID()}`,
    );
    try {
      const currentIdentity = fsSync.lstatSync(canonicalTargetDir, { bigint: true });
      await fs.mkdir(backupRoot, { recursive: true });
      await assertInstallBoundaryPaths({
        installBaseDir: installBaseRealPath,
        candidatePaths: [backupPath],
      });
      await assertInstallBaseStable({
        installBaseDir,
        expectedRealPath: installBaseRealPath,
      });
      const backupRootIdentity = fsSync.lstatSync(backupRoot, { bigint: true });
      assertDirectoryIdentity(installBaseRealPath, baseIdentity);
      assertDirectoryIdentity(backupRoot, backupRootIdentity);
      assertDirectoryIdentity(canonicalTargetDir, currentIdentity);
      // Detach under the original owner before copying or deleting anything asynchronously.
      assertPersistentApply();
      fsSync.renameSync(canonicalTargetDir, backupPath);
      backup = { path: backupPath, sourceHardlinks: "allow" };
      if (sourceHardlinks === "reject") {
        const checkedPath = `${backupPath}.checked`;
        try {
          await movePathWithCopyFallback({
            from: backupPath,
            to: checkedPath,
            sourceHardlinks: "reject",
            assertBeforeRename: assertOwned,
          });
          backup = { path: checkedPath, sourceHardlinks: "reject" };
        } catch (error) {
          if (fsSync.lstatSync(checkedPath, { throwIfNoEntry: false })?.isDirectory()) {
            backup = { path: checkedPath, sourceHardlinks: "reject" };
            if (fsSync.lstatSync(backupPath, { throwIfNoEntry: false })) {
              throw new Error(`${String(error)}; original backup retained at ${backupPath}`, {
                cause: error,
              });
            }
          }
          throw error;
        }
      }
    } catch (err) {
      // A rejected hardlink check restores the untouched original, not another checked copy.
      return await fail(`${params.copyErrorPrefix}: ${String(err)}`, err);
    }
  }

  if (backup && params.afterBackup) {
    // Validate the moved original, not its former path: new path-based writes now
    // reach the replacement, while a refusal can still restore the original tree.
    try {
      const backupResult = await params.afterBackup(backup.path);
      if (!backupResult.ok) {
        const failed = await fail(backupResult.error);
        return { ...backupResult, error: failed.error };
      }
    } catch (err) {
      return await fail(`backup validation failed: ${String(err)}`, err);
    }
  }

  try {
    await assertInstallBaseStable({
      installBaseDir,
      expectedRealPath: installBaseRealPath,
    });
    await movePathWithCopyFallback({
      assertBeforeRename: assertPersistentApply,
      from: stageDir,
      sourceHardlinks,
      to: canonicalTargetDir,
    });
    stageDir = null;
  } catch (err) {
    return await fail(`${params.copyErrorPrefix}: ${String(err)}`, err);
  }

  if (backup) {
    try {
      await assertInstallBaseStable({
        installBaseDir,
        expectedRealPath: installBaseRealPath,
      });
    } catch (err) {
      if (isInstallBaseChangedError(err)) {
        params.logger?.warn?.(INSTALL_BASE_CHANGED_BACKUP_WARNING);
      }
      backup = null;
    }
  }
  if (backup && !deferCommit) {
    await fs.rm(backup.path, { recursive: true, force: true }).catch(() => undefined);
  }
  if (stageDir) {
    await cleanupInstallTempDir(stageDir);
  }

  if (!deferCommit) {
    return { ...postInstallResult };
  }
  const installedIdentity = fsSync.lstatSync(canonicalTargetDir, { bigint: true });
  const assertRollbackOwned = () => {
    assertDirectoryIdentity(installBaseRealPath, baseIdentity);
    assertOwned?.();
  };
  let quarantine: { directory: string; identity: fsSync.BigIntStats } | undefined;
  let settlement: Promise<void> | undefined;
  const settle = (apply: () => Promise<void>) => {
    // Share in-flight settlement, but retain rollback progress when an I/O failure needs a retry.
    settlement ??= Promise.resolve()
      .then(apply)
      .catch((error: unknown) => {
        settlement = undefined;
        throw error;
      });
    return settlement;
  };
  return attachPackageDirInstallTransaction(
    { ...postInstallResult },
    {
      commit: () =>
        settle(async () => {
          if (quarantine) {
            throw new Error("cannot commit an install after rollback has started");
          }
          assertOwned?.();
          if (backup) {
            await fs.rm(backup.path, { recursive: true, force: true }).catch(() => undefined);
          }
        }),
      rollback: () =>
        settle(async () => {
          assertRollbackOwned();
          if (!quarantine) {
            const directory = await fs.mkdtemp(
              path.join(installBaseRealPath, ".openclaw-install-rollback-"),
            );
            const identity = fsSync.lstatSync(directory, { bigint: true });
            try {
              assertDirectoryIdentity(directory, identity);
              assertDirectoryIdentity(canonicalTargetDir, installedIdentity);
              // Detach atomically before any recursive deletion. Copy fallback would still
              // clean the shared source after ownership can close, so it is forbidden here.
              assertRollbackOwned();
              fsSync.renameSync(canonicalTargetDir, path.join(directory, "package"));
              quarantine = { directory, identity };
            } catch (error) {
              await fs.rmdir(directory).catch(() => undefined);
              throw error;
            }
          }
          assertDirectoryIdentity(quarantine.directory, quarantine.identity);
          const discardedPackage = path.join(quarantine.directory, "package");
          if (fsSync.lstatSync(discardedPackage, { bigint: true, throwIfNoEntry: false })) {
            assertDirectoryIdentity(discardedPackage, installedIdentity);
          }
          await fs.rm(discardedPackage, { recursive: true, force: true });
          await restoreBackup();
          await fs.rmdir(quarantine.directory);
        }),
    },
  );
}
