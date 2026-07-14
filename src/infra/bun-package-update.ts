import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { formatErrorMessage } from "./errors.js";
import { readPackageVersion } from "./package-json.js";
import { runPackagePostinstall, runPackageRuntimeGuard } from "./package-update-lifecycle.js";
import type { PackageUpdateStepResult, PackageUpdateStepRunner } from "./package-update-types.js";
import {
  collectInstalledGlobalPackageErrors,
  globalInstallArgs,
  resolveExpectedInstalledVersionFromSpec,
  type ResolvedGlobalInstallTarget,
} from "./update-global.js";

type BunPackageUpdateResult = {
  steps: PackageUpdateStepResult[];
  verifiedPackageRoot: string | null;
  afterVersion: string | null;
  failedStep: PackageUpdateStepResult | null;
};

type BunManagedRootSnapshot = {
  activeRoot: string;
  backupContainer: string;
  backupRoot: string;
  existed: boolean;
};

type BunActiveInstallBackup = {
  packageRoot: string;
  projectRoot: string;
  roots: BunManagedRootSnapshot[];
};

async function removeTree(targetPath: string): Promise<void> {
  await fs.rm(targetPath, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
}

async function readVersionIfPresent(packageRoot: string | null): Promise<string | null> {
  if (!packageRoot) {
    return null;
  }
  return readPackageVersion(packageRoot).catch(() => null);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function sameOrNestedPath(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function collapseManagedRoots(roots: string[]): string[] {
  const unique = [...new Set(roots.map((root) => path.resolve(root)))].sort(
    (left, right) => left.length - right.length,
  );
  return unique.filter(
    (candidate, index) =>
      !unique.slice(0, index).some((parent) => sameOrNestedPath(parent, candidate)),
  );
}

function assertSafeManagedRoot(root: string): void {
  if (path.parse(root).root === root) {
    throw new Error(`refusing to snapshot filesystem root ${root}`);
  }
}

async function snapshotManagedRoot(activeRoot: string): Promise<BunManagedRootSnapshot> {
  assertSafeManagedRoot(activeRoot);
  const parentRoot = path.dirname(activeRoot);
  await fs.mkdir(parentRoot, { recursive: true });
  const backupContainer = await fs.mkdtemp(
    path.join(parentRoot, `.openclaw-bun-backup-${process.pid}-`),
  );
  const backupRoot = path.join(backupContainer, "root");
  const existed = await pathExists(activeRoot);
  try {
    if (existed) {
      const stat = await fs.lstat(activeRoot);
      if (!stat.isDirectory()) {
        throw new Error(`Bun-managed root is not a directory: ${activeRoot}`);
      }
      await fs.cp(activeRoot, backupRoot, {
        recursive: true,
        force: false,
        errorOnExist: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
    }
    return { activeRoot, backupContainer, backupRoot, existed };
  } catch (error) {
    await removeTree(backupContainer).catch(() => undefined);
    throw error;
  }
}

async function cleanupManagedRootSnapshots(roots: BunManagedRootSnapshot[]): Promise<void> {
  await Promise.all(roots.map((root) => removeTree(root.backupContainer).catch(() => undefined)));
}

async function backupActiveBunInstall(params: {
  installTarget: ResolvedGlobalInstallTarget;
  packageName: string;
  packageRoot: string;
  binRoot: string;
}): Promise<BunActiveInstallBackup> {
  const globalRoot = params.installTarget.globalRoot;
  if (
    !globalRoot ||
    path.basename(globalRoot) !== "node_modules" ||
    path.resolve(params.packageRoot) !== path.resolve(globalRoot, params.packageName)
  ) {
    throw new Error("cannot resolve the active Bun global project for rollback");
  }

  const projectRoot = path.dirname(globalRoot);
  const binRoot = path.resolve(params.binRoot);
  const roots: BunManagedRootSnapshot[] = [];
  try {
    for (const activeRoot of collapseManagedRoots([projectRoot, binRoot])) {
      roots.push(await snapshotManagedRoot(activeRoot));
    }
  } catch (error) {
    await cleanupManagedRootSnapshots(roots);
    throw error;
  }
  return { packageRoot: params.packageRoot, projectRoot, roots };
}

async function restoreActiveBunInstall(backup: BunActiveInstallBackup): Promise<void> {
  const errors: string[] = [];
  for (const root of backup.roots) {
    try {
      await removeTree(root.activeRoot);
      if (root.existed) {
        await fs.mkdir(path.dirname(root.activeRoot), { recursive: true });
        await fs.rename(root.backupRoot, root.activeRoot);
      }
      await removeTree(root.backupContainer);
    } catch (error) {
      errors.push(`${root.activeRoot}: ${formatErrorMessage(error)}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
}

function createFailureStep(params: {
  name: string;
  command: string;
  cwd: string;
  error: unknown;
}): PackageUpdateStepResult {
  return {
    name: params.name,
    command: params.command,
    cwd: params.cwd,
    durationMs: 0,
    exitCode: 1,
    stdoutTail: null,
    stderrTail: formatErrorMessage(params.error),
  };
}

async function rollbackStep(backup: BunActiveInstallBackup): Promise<PackageUpdateStepResult> {
  const startedAt = Date.now();
  try {
    await restoreActiveBunInstall(backup);
    return {
      name: "global install rollback",
      command: `restore ${backup.roots.map((root) => root.activeRoot).join(", ")}`,
      cwd: path.dirname(backup.projectRoot),
      durationMs: Date.now() - startedAt,
      exitCode: 0,
      stdoutTail: "restored the previous Bun global project and bin state",
      stderrTail: null,
    };
  } catch (error) {
    return createFailureStep({
      name: "global install rollback",
      command: `restore ${backup.roots.map((root) => root.activeRoot).join(", ")}`,
      cwd: path.dirname(backup.projectRoot),
      error,
    });
  }
}

function verificationStep(packageRoot: string, errors: string[]): PackageUpdateStepResult {
  return {
    name: "global install verify",
    command: `verify ${packageRoot}`,
    cwd: packageRoot,
    durationMs: 0,
    exitCode: 1,
    stdoutTail: null,
    stderrTail: errors.join("\n"),
  };
}

function forceBunInstallArgs(target: ResolvedGlobalInstallTarget, spec: string): string[] {
  const argv = globalInstallArgs(target, spec);
  return [...argv.slice(0, -1), "--force", argv.at(-1) ?? spec];
}

async function fingerprintPackageTree(packageRoot: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        hash.update(`directory\0${relativePath}\0`);
        await walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        hash.update(`file\0${relativePath}\0`);
        hash.update(await fs.readFile(absolutePath));
      } else if (entry.isSymbolicLink()) {
        hash.update(`symlink\0${relativePath}\0${await fs.readlink(absolutePath)}\0`);
      } else {
        throw new Error(`unsupported package entry type at ${absolutePath}`);
      }
    }
  };
  await walk(packageRoot, "");
  return hash.digest("hex");
}

/** Stages Bun natively, then snapshots all manager-owned state before live activation. */
export async function runBunGlobalPackageUpdateSteps(params: {
  installTarget: ResolvedGlobalInstallTarget;
  installSpec: string;
  packageName: string;
  packageRoot?: string | null;
  binRoot: string;
  runStep: PackageUpdateStepRunner;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  installCwd?: string;
  runtimeVersion?: string | null;
  nodePath?: string;
  postVerifyStep?: (packageRoot: string) => Promise<PackageUpdateStepResult | null>;
}): Promise<BunPackageUpdateResult> {
  const livePackageRoot = params.installTarget.packageRoot ?? params.packageRoot ?? null;
  const steps: PackageUpdateStepResult[] = [];
  const stageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bun-update-stage-"));
  const inheritedEnv = params.env ?? process.env;
  // Pin the bin root resolved by `bun pm bin -g`. Explicit env wins over
  // bunfig, so the live command can mutate only the root snapshotted below.
  const liveEnv = { ...inheritedEnv, BUN_INSTALL_BIN: path.resolve(params.binRoot) };
  let activeBackup: BunActiveInstallBackup | null = null;
  let activationStarted = false;
  let preserveBackups = false;

  const rollbackAfterFailure = async (
    failedStep: PackageUpdateStepResult,
  ): Promise<BunPackageUpdateResult> => {
    if (!activeBackup) {
      throw new Error("missing Bun install rollback snapshot");
    }
    const rollback = await rollbackStep(activeBackup);
    activationStarted = false;
    if (rollback.exitCode !== 0) {
      preserveBackups = true;
      rollback.stderrTail = [
        rollback.stderrTail,
        `Rollback backups retained at ${activeBackup.roots
          .map((root) => root.backupRoot)
          .join(", ")}`,
      ]
        .filter(Boolean)
        .join("\n");
    }
    steps.push(rollback);
    return {
      steps,
      verifiedPackageRoot: livePackageRoot,
      afterVersion: await readVersionIfPresent(livePackageRoot),
      failedStep: rollback.exitCode === 0 ? failedStep : rollback,
    };
  };

  try {
    const stageGlobalDir = path.join(stageRoot, "global");
    const stageGlobalRoot = path.join(stageGlobalDir, "node_modules");
    const stageBinRoot = path.join(stageRoot, "bin");
    const stagePackageRoot = path.join(stageGlobalRoot, params.packageName);
    const stageTarget: ResolvedGlobalInstallTarget = {
      ...params.installTarget,
      globalRoot: stageGlobalRoot,
      packageRoot: stagePackageRoot,
    };
    const stageEnv = {
      ...inheritedEnv,
      BUN_INSTALL: stageRoot,
      BUN_INSTALL_GLOBAL_DIR: stageGlobalDir,
      BUN_INSTALL_BIN: stageBinRoot,
    };
    const stageStep = await params.runStep({
      name: "global update stage",
      argv: globalInstallArgs(stageTarget, params.installSpec),
      cwd: params.installCwd,
      timeoutMs: params.timeoutMs,
      env: stageEnv,
    });
    steps.push(stageStep);
    if (stageStep.exitCode !== 0) {
      return {
        steps,
        verifiedPackageRoot: livePackageRoot,
        afterVersion: await readVersionIfPresent(livePackageRoot),
        failedStep: stageStep,
      };
    }

    const guardStep = await runPackageRuntimeGuard(
      stagePackageRoot,
      params.runtimeVersion === undefined ? (process.versions.node ?? null) : params.runtimeVersion,
      "global update stage runtime guard",
    );
    steps.push(guardStep);
    if (guardStep.exitCode !== 0) {
      return {
        steps,
        verifiedPackageRoot: livePackageRoot,
        afterVersion: await readVersionIfPresent(livePackageRoot),
        failedStep: guardStep,
      };
    }

    const candidateVersion = await readPackageVersion(stagePackageRoot);
    const stageErrors = await collectInstalledGlobalPackageErrors({
      packageRoot: stagePackageRoot,
      expectedVersion: resolveExpectedInstalledVersionFromSpec(
        params.packageName,
        params.installSpec,
      ),
    });
    if (stageErrors.length > 0) {
      const failedStep = verificationStep(stagePackageRoot, stageErrors);
      steps.push(failedStep);
      return {
        steps,
        verifiedPackageRoot: livePackageRoot,
        afterVersion: await readVersionIfPresent(livePackageRoot),
        failedStep,
      };
    }
    const stageFingerprint = await fingerprintPackageTree(stagePackageRoot);

    if (!livePackageRoot) {
      const failedStep = createFailureStep({
        name: "global install backup",
        command: "resolve active Bun package root",
        cwd: params.installCwd ?? process.cwd(),
        error: new Error("could not resolve the active Bun package root before update"),
      });
      steps.push(failedStep);
      return { steps, verifiedPackageRoot: null, afterVersion: null, failedStep };
    }

    try {
      activeBackup = await backupActiveBunInstall({
        installTarget: params.installTarget,
        packageName: params.packageName,
        packageRoot: livePackageRoot,
        binRoot: params.binRoot,
      });
    } catch (error) {
      const failedStep = createFailureStep({
        name: "global install backup",
        command: `backup ${livePackageRoot}`,
        cwd: path.dirname(livePackageRoot),
        error,
      });
      steps.push(failedStep);
      return {
        steps,
        verifiedPackageRoot: livePackageRoot,
        afterVersion: await readVersionIfPresent(livePackageRoot),
        failedStep,
      };
    }

    activationStarted = true;
    const updateStep = await params.runStep({
      name: "global update",
      // Force prevents same-version no-op installs while preserving the user's source spec.
      argv: forceBunInstallArgs(params.installTarget, params.installSpec),
      cwd: params.installCwd,
      timeoutMs: params.timeoutMs,
      env: liveEnv,
    });
    steps.push(updateStep);
    if (updateStep.exitCode !== 0) {
      return await rollbackAfterFailure(updateStep);
    }

    const liveGuardStep = await runPackageRuntimeGuard(
      livePackageRoot,
      params.runtimeVersion === undefined ? (process.versions.node ?? null) : params.runtimeVersion,
    );
    steps.push(liveGuardStep);
    if (liveGuardStep.exitCode !== 0) {
      return await rollbackAfterFailure(liveGuardStep);
    }

    const liveFingerprint = await fingerprintPackageTree(livePackageRoot);
    if (liveFingerprint !== stageFingerprint) {
      const failedStep = createFailureStep({
        name: "global install candidate match",
        command: `compare staged and live package trees for ${params.installSpec}`,
        cwd: livePackageRoot,
        error: new Error("live Bun install did not match the staged candidate"),
      });
      steps.push(failedStep);
      return await rollbackAfterFailure(failedStep);
    }

    const postinstallStep = await runPackagePostinstall({
      packageRoot: livePackageRoot,
      runStep: params.runStep,
      timeoutMs: params.timeoutMs,
      env: liveEnv,
      ...(params.nodePath === undefined ? {} : { nodePath: params.nodePath }),
    });
    if (postinstallStep) {
      steps.push(postinstallStep);
      if (postinstallStep.exitCode !== 0) {
        return await rollbackAfterFailure(postinstallStep);
      }
    }

    const liveErrors = await collectInstalledGlobalPackageErrors({
      packageRoot: livePackageRoot,
      expectedVersion: candidateVersion,
    });
    if (liveErrors.length > 0) {
      const failedStep = verificationStep(livePackageRoot, liveErrors);
      steps.push(failedStep);
      return await rollbackAfterFailure(failedStep);
    }

    const postVerifyStep = await params.postVerifyStep?.(livePackageRoot);
    if (postVerifyStep) {
      steps.push(postVerifyStep);
      if (postVerifyStep.exitCode !== 0 && !postVerifyStep.advisory) {
        return await rollbackAfterFailure(postVerifyStep);
      }
    }

    activationStarted = false;
    return {
      steps,
      verifiedPackageRoot: livePackageRoot,
      afterVersion: candidateVersion,
      failedStep: null,
    };
  } catch (error) {
    const failedStep = createFailureStep({
      name: activationStarted ? "global update" : "global update stage",
      command: activationStarted ? "activate Bun update" : "prepare Bun update stage",
      cwd: activationStarted && livePackageRoot ? livePackageRoot : stageRoot,
      error,
    });
    steps.push(failedStep);
    if (activationStarted && activeBackup) {
      return await rollbackAfterFailure(failedStep);
    }
    return {
      steps,
      verifiedPackageRoot: livePackageRoot,
      afterVersion: await readVersionIfPresent(livePackageRoot),
      failedStep,
    };
  } finally {
    if (!preserveBackups && activeBackup) {
      await cleanupManagedRootSnapshots(activeBackup.roots);
    }
    await removeTree(stageRoot).catch(() => undefined);
  }
}
