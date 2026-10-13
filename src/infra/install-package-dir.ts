// Installs package directories under canonical plugin roots.
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { assertDirectoryIdentitySync, readDirectoryIdentity } from "@openclaw/fs-safe/advanced";
import {
  movePathWithCopyFallback,
  type MovePathPublicationReceipt,
} from "@openclaw/fs-safe/atomic";
import { isRecord as isObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { runCommandWithTimeout } from "../process/exec.js";
import { hasErrnoCode } from "./errno.js";
import { isRemovalIoError, removePathWithinRoot } from "./fs-safe-remove.js";
import { FsSafeError, pathExists } from "./fs-safe.js";
import { resolveInstallWorkTimeoutMs } from "./install-mode-options.js";
import { withInstallActivity, type InstallActivityObserver } from "./install-progress.js";
import { assertCanonicalPathWithinBase } from "./install-safe-path.js";
import { formatNpmCommandFailureOutput } from "./install-source-utils.js";
import { tryReadJson, writeJson } from "./json-files.js";
import { retainMutationAuthority } from "./mutation-authority.js";
import { resolveNpmCommand } from "./npm-command.js";
import { createSafeNpmInstallArgs, createSafeNpmInstallEnv } from "./safe-package-install.js";

type InstallSourceHardlinks = "package-manager" | "reject";

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

async function sanitizeManifestForNpmInstall(
  targetDir: string,
  omitOpenClawHostDependency: boolean,
): Promise<() => Promise<void>> {
  const manifestPath = path.join(targetDir, "package.json");
  const parsed = await tryReadJson<unknown>(manifestPath);
  if (!isObjectRecord(parsed)) {
    return () => Promise.resolve();
  }
  const manifest = parsed;
  const originalManifest = await fs.readFile(manifestPath);
  let changed = false;

  // npm resolves omitted development dependencies even when it does not install them.
  if (Object.hasOwn(manifest, "devDependencies")) {
    delete manifest.devDependencies;
    changed = true;
  }

  if (omitOpenClawHostDependency) {
    for (const key of [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
      "peerDependenciesMeta",
    ] as const) {
      const dependencies = manifest[key];
      if (!isObjectRecord(dependencies) || !Object.hasOwn(dependencies, "openclaw")) {
        continue;
      }
      delete dependencies.openclaw;
      if (Object.keys(dependencies).length === 0) {
        delete manifest[key];
      }
      changed = true;
    }
  }

  if (changed) {
    await writeJson(manifestPath, manifest, { trailingNewline: true });
    return async () => {
      await fs.writeFile(manifestPath, originalManifest);
    };
  }
  return () => Promise.resolve();
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

function isInstallBaseChangedError(error: unknown): boolean {
  return error instanceof Error && error.message === INSTALL_BASE_CHANGED_ERROR_MESSAGE;
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

async function resolveInstallPublishTarget(params: {
  installBaseDir: string;
  targetDir: string;
}): Promise<{ installBaseRealPath: string; canonicalTargetDir: string }> {
  const installBaseResolved = path.resolve(params.installBaseDir);
  const targetResolved = path.resolve(params.targetDir);
  const targetRelativePath = path.relative(installBaseResolved, targetResolved);
  if (
    !targetRelativePath ||
    targetRelativePath === ".." ||
    targetRelativePath.startsWith(`..${path.sep}`)
  ) {
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

export function resolvePackageDirInstallTransaction(
  result: object,
): PackageDirInstallTransaction | undefined {
  return (result as { [PACKAGE_DIR_INSTALL_TRANSACTION]?: PackageDirInstallTransaction })[
    PACKAGE_DIR_INSTALL_TRANSACTION
  ];
}

/**
 * Publishes a copied package or a privately prepared package directory into its install target.
 * Update mode backs up the existing target, runs optional validation hooks,
 * and rolls back when copy, dependency install, or validation fails.
 */
export async function installPackageDir<
  TAfterInstallFailure extends InstallPackageDirFailure = InstallPackageDirFailure,
>(params: {
  sourceDir?: string;
  targetDir: string;
  mode: "install" | "update";
  timeoutMs: number;
  workTimeoutMs?: number | null;
  logger?: InstallActivityObserver & {
    info?: (message: string) => void;
    warn?: (message: string) => void;
  };
  copyErrorPrefix: string;
  hasDeps: boolean;
  omitOpenClawHostDependency?: boolean;
  sourceHardlinks?: InstallSourceHardlinks;
  depsLogMessage: string;
  afterCopy?: (installedDir: string) => void | Promise<void>;
  afterInstall?: (installedDir: string) => Promise<InstallPackageDirSuccess | TAfterInstallFailure>;
  afterBackup?: (backupDir: string) => Promise<InstallPackageDirSuccess | TAfterInstallFailure>;
  beforePersistentApply?: () => void;
  /** Remote owners answer before displacement/publication; local checks still run at the mutation. */
  authorizeMutation?: () => Promise<void>;
}): Promise<InstallPackageDirSuccess | InstallPackageDirFailure | TAfterInstallFailure> {
  const transactionRequest = resolvePackageDirInstallTransactionRequest(params);
  const deferCommit = transactionRequest !== undefined;
  // A retry cannot revive a refused transaction or borrow a successor's lease.
  // Publication-only cancellation remains separate so the owner can still roll back.
  const assertOwned = retainMutationAuthority(transactionRequest?.assertOwned ?? (() => {}));
  params.logger?.info?.(`Installing to ${params.targetDir}…`);
  const installBaseDir = path.dirname(params.targetDir);
  let initialInstallBaseRealPath: string;
  try {
    await fs.mkdir(installBaseDir, { recursive: true });
    initialInstallBaseRealPath = await fs.realpath(installBaseDir);
    await assertCanonicalPathWithinBase({
      baseDir: installBaseDir,
      candidatePath: params.targetDir,
      boundaryLabel: "install directory",
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

  const baseIdentity = await readDirectoryIdentity(installBaseRealPath);
  const assertDirectoryIdentity = (directory: string, identity: { dev: bigint; ino: bigint }) => {
    try {
      // Publication receipts survive relocation into rollback quarantine.
      assertDirectoryIdentitySync(directory, { dev: identity.dev, ino: identity.ino });
    } catch (error) {
      if (error instanceof FsSafeError && error.category === "policy") {
        throw new Error(`install directory changed: ${directory}`, { cause: error });
      }
      throw error;
    }
  };
  const assertRollbackOwned = () => {
    assertOwned();
    assertDirectoryIdentity(installBaseRealPath, baseIdentity);
  };
  const assertPersistentApply = retainMutationAuthority(() => {
    assertRollbackOwned();
    return params.beforePersistentApply?.();
  });
  const removeInstallTree = async (removal: {
    directory: string;
    identity: { dev: bigint; ino: bigint };
    assertOwner: () => void;
    recursive?: boolean;
    bestEffort?: boolean;
  }) => {
    const assertCurrent = retainMutationAuthority(() => {
      removal.assertOwner();
      assertDirectoryIdentity(installBaseRealPath, baseIdentity);
      if (fsSync.lstatSync(removal.directory, { throwIfNoEntry: false })) {
        assertDirectoryIdentity(removal.directory, removal.identity);
      }
    });
    try {
      await removePathWithinRoot({
        rootDir: installBaseRealPath,
        relativePath: path.relative(installBaseRealPath, removal.directory),
        recursive: removal.recursive !== false,
        force: true,
        symlinks: "unlink",
        assertBeforeMutation: assertCurrent,
      });
    } catch (error) {
      assertCurrent();
      if (!removal.bestEffort || !isRemovalIoError(error)) {
        throw error;
      }
    }
  };
  let stageDir: string | null = null;
  const published: {
    backup: MovePathPublicationReceipt | null;
    install: MovePathPublicationReceipt | null;
    restore: MovePathPublicationReceipt | null;
  } = { backup: null, install: null, restore: null };
  const sourceHardlinks = params.sourceHardlinks === "package-manager" ? "allow" : "reject";
  const assertInstallBase = () =>
    assertInstallBaseStable({ installBaseDir, expectedRealPath: installBaseRealPath });
  const publish = async (from: string, to: string, kind: "backup" | "install") => {
    await assertInstallBase();
    // Displacement and publication require the same final ownership check.
    if (params.authorizeMutation) {
      await params.authorizeMutation();
    }
    await movePathWithCopyFallback({
      assertBeforeMutation: assertPersistentApply,
      onDestinationPublished: (receipt) => {
        published[kind] = receipt;
      },
      from,
      sourceHardlinks,
      to,
    });
  };
  const discardBackup = async (assertOwner: () => void) => {
    if (published.backup) {
      await removeInstallTree({
        directory: published.backup.path,
        identity: published.backup,
        assertOwner,
        bestEffort: true,
      });
    }
  };
  let quarantine:
    | { directory: string; identity: Awaited<ReturnType<typeof readDirectoryIdentity>> }
    | undefined;
  const rollback = async () => {
    const installedIdentity = published.install;
    if (installedIdentity) {
      assertRollbackOwned();
      if (published.backup && !published.restore) {
        assertDirectoryIdentity(published.backup.path, published.backup);
      }
      if (!quarantine) {
        const directory = await fs.mkdtemp(
          path.join(installBaseRealPath, ".openclaw-install-rollback-"),
        );
        const identity = await readDirectoryIdentity(directory);
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
      const detached = quarantine;
      await removeInstallTree({
        directory: path.join(detached.directory, "package"),
        identity: installedIdentity,
        // Detachment transferred this object into private cleanup custody. Its
        // original identities remain required even when the update lease closes.
        assertOwner: () => assertDirectoryIdentity(detached.directory, detached.identity),
      });
    }
    await restoreBackup();
    if (quarantine) {
      await removeInstallTree({
        directory: quarantine.directory,
        identity: quarantine.identity,
        assertOwner: () => {},
        recursive: false,
      });
    }
    published.install = null;
  };
  const fail = async (error: string, cause?: unknown) => {
    const installBaseChanged = isInstallBaseChangedError(cause);
    let restoreError: string | undefined;
    if (installBaseChanged) {
      params.logger?.warn?.(INSTALL_BASE_CHANGED_ABORT_WARNING);
    } else {
      try {
        await rollback();
      } catch (restoreFailure) {
        restoreError = String(restoreFailure);
      }
      if (stageDir) {
        await fs.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
        stageDir = null;
      }
    }
    const recovery = [
      restoreError && `could not restore existing install: ${restoreError}`,
      published.install &&
        `install was published at ${published.install.path}; recovery incomplete`,
      published.backup && `backup recovery path: ${published.backup.path}`,
    ].filter(Boolean);
    return {
      ok: false as const,
      error: [error, ...recovery].join("; "),
    };
  };
  const restoreBackup = async (): Promise<void> => {
    if (!published.backup) {
      return;
    }
    const restoring = published.backup;
    try {
      if (published.restore) {
        // A prior attempt restored the target; retry only its remaining backup cleanup.
        const restored = published.restore;
        await removeInstallTree({
          directory: restoring.path,
          identity: restoring,
          assertOwner: () => {
            assertDirectoryIdentity(canonicalTargetDir, restored);
            assertRollbackOwned();
          },
        });
      } else {
        await movePathWithCopyFallback({
          assertBeforeRename: () => {
            assertDirectoryIdentity(restoring.path, restoring);
            if (fsSync.lstatSync(canonicalTargetDir, { throwIfNoEntry: false })) {
              throw new Error(`install target changed during rollback: ${canonicalTargetDir}`);
            }
          },
          assertBeforeMutation: () => {
            assertDirectoryIdentity(restoring.path, restoring);
            assertRollbackOwned();
          },
          onDestinationPublished: (receipt) => {
            published.restore = receipt;
          },
          from: restoring.path,
          sourceHardlinks,
          to: canonicalTargetDir,
        });
      }
      published.backup = null;
    } catch (error) {
      const recovery = published.restore
        ? `original install published at ${published.restore.path}; cleanup incomplete at ${restoring.path}`
        : `backup retained at ${restoring.path}`;
      throw new Error(`${String(error)}; ${recovery}`, { cause: error });
    }
  };
  const validate = async (
    run: () => Promise<InstallPackageDirSuccess | TAfterInstallFailure>,
    label: string,
  ) => {
    try {
      const result = await run();
      if (!result.ok) {
        const failed = await fail(result.error);
        return { ...result, error: failed.error };
      }
      return null;
    } catch (error) {
      return await fail(`${label} validation failed: ${String(error)}`, error);
    }
  };

  try {
    await assertCanonicalPathWithinBase({
      baseDir: installBaseRealPath,
      candidatePath: canonicalTargetDir,
      boundaryLabel: "install directory",
    });
    stageDir = await fs.mkdtemp(path.join(installBaseRealPath, ".openclaw-install-stage-"));
    if (params.sourceDir !== undefined) {
      await withInstallActivity(params.logger, "files", () =>
        fs.cp(params.sourceDir!, stageDir!, {
          recursive: true,
          // Keep relative symlinks relative to the staged copy. Node's default
          // rewrites them toward the source tree, which makes valid vendored
          // package links look like install-root escapes during post-copy scans.
          verbatimSymlinks: true,
        }),
      );
    }
  } catch (err) {
    return await fail(`${params.copyErrorPrefix}: ${String(err)}`, err);
  }

  try {
    await params.afterCopy?.(stageDir);
  } catch (err) {
    return await fail(`post-copy validation failed: ${String(err)}`, err);
  }

  if (params.hasDeps) {
    const dependencyDir = stageDir;
    try {
      const restoreManifest = await sanitizeManifestForNpmInstall(
        stageDir,
        params.omitOpenClawHostDependency === true,
      );
      let npmFailure: string | undefined;
      try {
        const hiddenProjectNpmConfig = await hideProjectNpmConfigForInstall(stageDir);
        params.logger?.info?.(params.depsLogMessage);
        const npmRes = await withInstallActivity(
          params.logger,
          "dependencies",
          async () => {
            try {
              return await runCommandWithTimeout(
                // Plugins install into isolated directories, so omitting peer deps can strip
                // runtime requirements that npm would otherwise materialize for the package.
                // Verified on Blacksmith Ubuntu/Node 24/npm 11: `--silent` can make npm fail
                // with empty stdout/stderr for bad specs like `workspace:^`; `--loglevel=error`
                // stays quiet on success while preserving the actionable npm failure text.
                resolveNpmCommand(
                  createSafeNpmInstallArgs({
                    ignoreWorkspaces: true,
                  }),
                ),
                {
                  timeoutMs: resolveInstallWorkTimeoutMs(
                    params.workTimeoutMs,
                    Math.max(params.timeoutMs, 300_000),
                  ),
                  cwd: dependencyDir,
                  env: createSafeNpmInstallEnv(process.env, {
                    npmConfigCwd: dependencyDir,
                    ignoreWorkspaces: true,
                  }),
                },
              );
            } finally {
              await restoreProjectNpmConfigAfterInstall(hiddenProjectNpmConfig);
            }
          },
          (result) => result.code === 0,
        );
        if (npmRes.code !== 0) {
          npmFailure = `npm install failed: ${formatNpmCommandFailureOutput(npmRes)}`;
        }
      } finally {
        await restoreManifest();
      }
      if (npmFailure) {
        return await fail(npmFailure);
      }
    } catch (error) {
      return await fail(`npm install failed: ${String(error)}`, error);
    }
  }

  if (params.afterInstall) {
    const failure = await validate(() => params.afterInstall!(stageDir!), "post-install");
    if (failure) {
      return failure;
    }
  }

  if (params.mode === "update" && (await pathExists(canonicalTargetDir))) {
    const backupRoot = path.join(installBaseRealPath, ".openclaw-install-backups");
    const backupPath = path.join(
      backupRoot,
      `${path.basename(canonicalTargetDir)}-${randomUUID()}`,
    );
    try {
      await fs.mkdir(backupRoot, { recursive: true });
      await assertCanonicalPathWithinBase({
        baseDir: installBaseRealPath,
        candidatePath: backupPath,
        boundaryLabel: "install directory",
      });
      await publish(canonicalTargetDir, backupPath, "backup");
    } catch (err) {
      return await fail(`${params.copyErrorPrefix}: ${String(err)}`, err);
    }
  }

  if (published.backup && params.afterBackup) {
    // Validate the moved original, not its former path: new path-based writes now
    // reach the replacement, while a refusal can still restore the original tree.
    const failure = await validate(() => params.afterBackup!(published.backup!.path), "backup");
    if (failure) {
      return failure;
    }
  }

  try {
    await publish(stageDir, canonicalTargetDir, "install");
    stageDir = null;
  } catch (err) {
    return await fail(`${params.copyErrorPrefix}: ${String(err)}`, err);
  }

  if (published.backup) {
    try {
      await assertInstallBase();
    } catch (err) {
      if (isInstallBaseChangedError(err)) {
        params.logger?.warn?.(INSTALL_BASE_CHANGED_BACKUP_WARNING);
      }
      published.backup = null;
    }
  }
  if (!deferCommit) {
    await discardBackup(assertPersistentApply);
    return { ok: true };
  }
  let settlement: Promise<void> | undefined;
  const settle = (apply: () => Promise<void>) => {
    // Share in-flight settlement, but retain rollback progress when an I/O failure needs a retry.
    settlement ??= Promise.resolve()
      .then(() => {
        assertOwned();
        return apply();
      })
      .catch((error: unknown) => {
        settlement = undefined;
        throw error;
      });
    return settlement;
  };
  return Object.defineProperty(
    { ok: true } satisfies InstallPackageDirSuccess,
    PACKAGE_DIR_INSTALL_TRANSACTION,
    {
      configurable: false,
      enumerable: true,
      value: {
        commit: () =>
          settle(async () => {
            if (quarantine) {
              throw new Error("cannot commit an install after rollback has started");
            }
            assertOwned();
            await discardBackup(assertRollbackOwned);
          }),
        rollback: () => settle(rollback),
      } satisfies PackageDirInstallTransaction,
    },
  );
}
