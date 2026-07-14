// Runs package update move, inventory, and cleanup steps.
import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "./errors.js";
import { pathExists } from "./fs-safe.js";
import { readPackageVersion } from "./package-json.js";
import {
  createPackageRuntimeEnv,
  resolvePackageRuntimeNpmInvocation,
} from "./package-runtime-env.js";
import {
  resolvePackageRuntime,
  runPackedPackageRuntimeGuard,
  runPackageInstallLifecycle,
} from "./package-update-lifecycle.js";
import { preparePackedPackageInstallSpec } from "./package-update-source.js";
import type { PackageUpdateStepResult, PackageUpdateStepRunner } from "./package-update-types.js";
import { movePathWithCopyFallback } from "./replace-file.js";
import { trimLogTail } from "./restart-sentinel.js";
import {
  PACKAGE_POST_INSTALL_DOCTOR_ADVISORY,
  UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
  type PackageUpdateStepAdvisory,
  type UpdatePostInstallDoctorResult,
} from "./update-doctor-result.js";
export type { PackageUpdateStepAdvisory } from "./update-doctor-result.js";
import {
  collectInstalledGlobalPackageErrors,
  globalInstallArgs,
  globalInstallFallbackArgs,
  resolveNpmGlobalPrefixLayoutFromGlobalRoot,
  resolveNpmGlobalPrefixLayoutFromPrefix,
  resolvePnpmGlobalDirFromGlobalRoot,
  resolveExpectedInstalledVersionFromSpec,
  resolveGlobalInstallTarget,
  type CommandRunner,
  type NpmGlobalPrefixLayout,
  type ResolvedGlobalInstallTarget,
} from "./update-global.js";

const PACKAGE_MANAGER_SWAP_SOURCE_HARDLINKS = "allow" as const;

type StagedNpmInstall = {
  prefix: string;
  layout: NpmGlobalPrefixLayout;
  packageRoot: string;
  installTarget: ResolvedGlobalInstallTarget;
};

type NpmBinShimBackup = {
  backupDir: string;
  targetBinDir: string;
  entries: Array<{
    name: string;
    hadExisting: boolean;
  }>;
};

function isBlockingPackageUpdateStep(step: PackageUpdateStepResult): boolean {
  return step.exitCode !== 0 && step.advisory === undefined;
}

function isNormalProcessExit(step: {
  signal?: NodeJS.Signals | null;
  killed?: boolean;
  termination?: "exit" | "timeout" | "no-output-timeout" | "signal";
}): boolean {
  return (
    step.termination !== "timeout" &&
    step.termination !== "no-output-timeout" &&
    step.termination !== "signal" &&
    step.killed !== true &&
    (step.signal === undefined || step.signal === null)
  );
}

export function markPackagePostInstallDoctorAdvisory<
  T extends {
    exitCode: number | null;
    stderrTail?: string | null;
    signal?: NodeJS.Signals | null;
    killed?: boolean;
    termination?: "exit" | "timeout" | "no-output-timeout" | "signal";
    advisory?: PackageUpdateStepAdvisory;
  },
>(
  step: T,
  result: UpdatePostInstallDoctorResult | null,
): T & {
  advisory?: PackageUpdateStepAdvisory;
} {
  if (
    step.exitCode !== UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE ||
    result?.status !== "advisory" ||
    !isNormalProcessExit(step)
  ) {
    return step;
  }
  const advisoryTail = [
    step.stderrTail,
    ...result.advisory.details,
    PACKAGE_POST_INSTALL_DOCTOR_ADVISORY.message,
  ]
    .filter((line): line is string => Boolean(line?.trim()))
    .join("\n");
  return {
    ...step,
    advisory: PACKAGE_POST_INSTALL_DOCTOR_ADVISORY,
    stderrTail: trimLogTail(advisoryTail) ?? step.stderrTail,
  };
}

async function removePathBestEffort(targetPath: string): Promise<boolean> {
  try {
    await fs.rm(targetPath, {
      recursive: true,
      force: true,
      maxRetries: process.platform === "win32" ? 5 : 2,
      retryDelay: 100,
    });
    return true;
  } catch {
    return false;
  }
}

async function readPackageVersionIfPresent(packageRoot: string | null): Promise<string | null> {
  if (!packageRoot) {
    return null;
  }
  try {
    return await readPackageVersion(packageRoot);
  } catch {
    return null;
  }
}

function isUnambiguousNpmPrefixGlobalRoot(globalRoot: string | null): boolean {
  const trimmed = globalRoot?.trim();
  if (!trimmed) {
    return false;
  }
  const normalized = path.resolve(trimmed);
  if (path.basename(normalized) !== "node_modules") {
    return false;
  }
  const parentDir = path.dirname(normalized);
  if (path.basename(parentDir) === "lib") {
    return true;
  }
  return process.platform === "win32" && path.basename(parentDir).toLowerCase() === "npm";
}

function resolveStagedNpmTargetLayout(
  installTarget: ResolvedGlobalInstallTarget,
): NpmGlobalPrefixLayout | null {
  const targetLayout = resolveNpmGlobalPrefixLayoutFromGlobalRoot(installTarget.globalRoot, {
    allowDirectNodeModulesRoot: installTarget.directNodeModulesRoot === true,
  });
  if (!targetLayout) {
    return null;
  }
  if (
    installTarget.manager === "npm" ||
    isUnambiguousNpmPrefixGlobalRoot(installTarget.globalRoot)
  ) {
    return targetLayout;
  }
  return null;
}

async function createStagedNpmInstall(
  installTarget: ResolvedGlobalInstallTarget,
  packageName: string,
): Promise<StagedNpmInstall | null> {
  const targetLayout = resolveStagedNpmTargetLayout(installTarget);
  if (!targetLayout) {
    return null;
  }
  await fs.mkdir(targetLayout.globalRoot, { recursive: true });
  const prefix = await fs.mkdtemp(path.join(targetLayout.globalRoot, ".openclaw-update-stage-"));
  const layout = resolveNpmGlobalPrefixLayoutFromPrefix(prefix);
  const command = installTarget.manager === "npm" ? installTarget.command : "npm";
  return {
    prefix,
    layout,
    packageRoot: path.join(layout.globalRoot, packageName),
    installTarget: {
      manager: "npm",
      command,
      globalRoot: layout.globalRoot,
      packageRoot: path.join(layout.globalRoot, packageName),
    },
  };
}

async function prepareStagedNpmInstall(
  installTarget: ResolvedGlobalInstallTarget,
  packageName: string,
): Promise<{
  stagedInstall: StagedNpmInstall | null;
  failedStep: PackageUpdateStepResult | null;
}> {
  const startedAt = Date.now();
  try {
    return {
      stagedInstall: await createStagedNpmInstall(installTarget, packageName),
      failedStep: null,
    };
  } catch (err) {
    const targetLayout = resolveStagedNpmTargetLayout(installTarget);
    return {
      stagedInstall: null,
      failedStep: {
        name: "global install stage",
        command: "prepare staged npm install",
        cwd: targetLayout?.prefix ?? installTarget.globalRoot ?? process.cwd(),
        durationMs: Date.now() - startedAt,
        exitCode: 1,
        stdoutTail: null,
        stderrTail: formatErrorMessage(err),
      },
    };
  }
}

async function cleanupStagedNpmInstall(stage: StagedNpmInstall | null): Promise<void> {
  if (!stage) {
    return;
  }
  await removePathBestEffort(stage.prefix);
}

async function copyPathEntry(source: string, destination: string): Promise<void> {
  const stat = await fs.lstat(source);
  await removePathBestEffort(destination);
  if (stat.isSymbolicLink()) {
    await fs.symlink(await fs.readlink(source), destination);
    return;
  }
  if (stat.isDirectory()) {
    await fs.cp(source, destination, {
      recursive: true,
      force: true,
      preserveTimestamps: false,
    });
    return;
  }
  await fs.copyFile(source, destination);
  await fs.chmod(destination, stat.mode).catch(() => undefined);
}

async function replaceNpmBinShims(params: {
  stageLayout: NpmGlobalPrefixLayout;
  targetLayout: NpmGlobalPrefixLayout;
  packageName: string;
}): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(params.stageLayout.binDir);
  } catch {
    return;
  }

  const names = new Set([params.packageName, "openclaw"]);
  const shimEntries = entries.filter((entry) => {
    const parsed = path.parse(entry);
    return names.has(entry) || names.has(parsed.name);
  });
  if (shimEntries.length === 0) {
    return;
  }

  const backup: NpmBinShimBackup = {
    backupDir: await fs.mkdtemp(
      path.join(params.targetLayout.globalRoot, ".openclaw-shim-backup-"),
    ),
    targetBinDir: params.targetLayout.binDir,
    entries: [],
  };

  try {
    await fs.mkdir(params.targetLayout.binDir, { recursive: true });
    for (const entry of shimEntries) {
      const destination = path.join(params.targetLayout.binDir, entry);
      const hadExisting = await pathExists(destination);
      backup.entries.push({ name: entry, hadExisting });
      if (hadExisting) {
        await copyPathEntry(destination, path.join(backup.backupDir, entry));
      }
    }

    for (const entry of shimEntries) {
      await copyPathEntry(
        path.join(params.stageLayout.binDir, entry),
        path.join(params.targetLayout.binDir, entry),
      );
    }
  } catch (err) {
    await restoreNpmBinShimBackup(backup);
    throw err;
  } finally {
    await removePathBestEffort(backup.backupDir);
  }
}

async function restoreNpmBinShimBackup(backup: NpmBinShimBackup): Promise<void> {
  await fs.mkdir(backup.targetBinDir, { recursive: true });
  for (const entry of backup.entries) {
    const destination = path.join(backup.targetBinDir, entry.name);
    await removePathBestEffort(destination);
    if (entry.hadExisting) {
      await copyPathEntry(path.join(backup.backupDir, entry.name), destination);
    }
  }
}

async function swapStagedNpmInstall(params: {
  stage: StagedNpmInstall;
  installTarget: ResolvedGlobalInstallTarget;
  packageName: string;
}): Promise<PackageUpdateStepResult> {
  const startedAt = Date.now();
  const targetLayout = resolveNpmGlobalPrefixLayoutFromGlobalRoot(params.installTarget.globalRoot, {
    allowDirectNodeModulesRoot: params.installTarget.directNodeModulesRoot === true,
  });
  const targetPackageRoot = params.installTarget.packageRoot;
  if (!targetLayout || !targetPackageRoot) {
    return {
      name: "global install swap",
      command: "swap staged npm install",
      cwd: params.stage.prefix,
      durationMs: Date.now() - startedAt,
      exitCode: 1,
      stdoutTail: null,
      stderrTail: "cannot resolve npm global prefix layout",
    };
  }

  const backupRoot = path.join(targetLayout.globalRoot, `.openclaw-${process.pid}-${Date.now()}`);
  let movedExisting = false;
  let movedStaged = false;
  let removedBackup = true;
  try {
    await fs.mkdir(targetLayout.globalRoot, { recursive: true });
    if (await pathExists(targetPackageRoot)) {
      await movePathWithCopyFallback({
        from: targetPackageRoot,
        sourceHardlinks: PACKAGE_MANAGER_SWAP_SOURCE_HARDLINKS,
        to: backupRoot,
      });
      movedExisting = true;
    }
    await movePathWithCopyFallback({
      from: params.stage.packageRoot,
      sourceHardlinks: PACKAGE_MANAGER_SWAP_SOURCE_HARDLINKS,
      to: targetPackageRoot,
    });
    movedStaged = true;
    if (params.installTarget.directNodeModulesRoot !== true) {
      await replaceNpmBinShims({
        stageLayout: params.stage.layout,
        targetLayout,
        packageName: params.packageName,
      });
    }
    if (movedExisting) {
      removedBackup = await removePathBestEffort(backupRoot);
    }
    return {
      name: "global install swap",
      command: `swap ${params.stage.packageRoot} -> ${targetPackageRoot}`,
      cwd: targetLayout.globalRoot,
      durationMs: Date.now() - startedAt,
      exitCode: 0,
      stdoutTail: movedExisting
        ? removedBackup
          ? `replaced ${params.packageName}`
          : `replaced ${params.packageName}; preserved old package at ${backupRoot} for delayed cleanup`
        : `installed ${params.packageName}`,
      stderrTail: null,
    };
  } catch (err) {
    if (movedStaged) {
      await removePathBestEffort(targetPackageRoot);
    }
    if (movedExisting) {
      await movePathWithCopyFallback({
        from: backupRoot,
        sourceHardlinks: PACKAGE_MANAGER_SWAP_SOURCE_HARDLINKS,
        to: targetPackageRoot,
      }).catch(() => undefined);
    }
    return {
      name: "global install swap",
      command: `swap ${params.stage.packageRoot} -> ${targetPackageRoot}`,
      cwd: targetLayout.globalRoot,
      durationMs: Date.now() - startedAt,
      exitCode: 1,
      stdoutTail: null,
      stderrTail: formatErrorMessage(err),
    };
  }
}

/**
 * Runs the global package update flow, including npm staging when possible,
 * package verification, optional post-verification, and cleanup.
 */
export async function runGlobalPackageUpdateSteps(params: {
  installTarget: ResolvedGlobalInstallTarget;
  installSpec: string;
  packageName: string;
  packageRoot?: string | null;
  runCommand: CommandRunner;
  runStep: PackageUpdateStepRunner;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  installCwd?: string;
  nodePath?: string;
  postVerifyStep?: (packageRoot: string) => Promise<PackageUpdateStepResult | null>;
}): Promise<{
  steps: PackageUpdateStepResult[];
  verifiedPackageRoot: string | null;
  afterVersion: string | null;
  failedStep: PackageUpdateStepResult | null;
}> {
  const installCwd = params.installCwd === undefined ? {} : { cwd: params.installCwd };
  const installEnv = params.env === undefined ? {} : { env: params.env };
  let updateEnv = params.env;
  let stagedInstall: StagedNpmInstall | null | undefined;
  let packedInstallDir: string | null = null;

  try {
    const preparedInstall = await prepareStagedNpmInstall(params.installTarget, params.packageName);
    stagedInstall = preparedInstall.stagedInstall;
    if (preparedInstall.failedStep) {
      return {
        steps: [preparedInstall.failedStep],
        verifiedPackageRoot: params.packageRoot ?? null,
        afterVersion: null,
        failedStep: preparedInstall.failedStep,
      };
    }

    const steps: PackageUpdateStepResult[] = [];
    const installCommandTarget = stagedInstall?.installTarget ?? params.installTarget;
    // npm disables install scripts, so a direct npm update needs an immutable candidate guard.
    const requiresPackedGuard = stagedInstall == null && installCommandTarget.manager === "npm";
    const selectedRuntime =
      installCommandTarget.manager === "npm"
        ? await resolvePackageRuntime({
            runCommand: params.runCommand,
            timeoutMs: params.timeoutMs,
            ...(params.nodePath === undefined ? {} : { nodePath: params.nodePath }),
            ...installEnv,
            ...installCwd,
          })
        : { nodePath: null, version: null };
    updateEnv =
      installCommandTarget.manager === "npm"
        ? createPackageRuntimeEnv(params.env, selectedRuntime.nodePath)
        : params.env;
    let packCommandArgv: string[] | null = null;
    if (installCommandTarget.manager === "npm") {
      packCommandArgv = await resolvePackageRuntimeNpmInvocation({
        nodePath: selectedRuntime.nodePath,
        fallbackCommand: installCommandTarget.command,
        ...(params.installCwd === undefined ? {} : { cwd: params.installCwd }),
        ...(updateEnv === undefined ? {} : { env: updateEnv }),
      });
    }
    const preparedSpec = await preparePackedPackageInstallSpec({
      installTarget: installCommandTarget,
      installSpec: params.installSpec,
      packageName: params.packageName,
      runStep: params.runStep,
      timeoutMs: params.timeoutMs,
      runtimeVersion: selectedRuntime.version,
      env: updateEnv,
      installCwd: params.installCwd,
      forcePack: requiresPackedGuard,
      packCommandArgv,
    });
    const expectedInstalledVersion = resolveExpectedInstalledVersionFromSpec(
      params.packageName,
      params.installSpec,
    );
    packedInstallDir = preparedSpec.packDir;
    steps.push(...preparedSpec.steps);
    if (preparedSpec.failedStep) {
      return {
        steps,
        verifiedPackageRoot: params.packageRoot ?? null,
        afterVersion: null,
        failedStep: preparedSpec.failedStep,
      };
    }

    if (requiresPackedGuard) {
      const runtimeGuardStep = await runPackedPackageRuntimeGuard(
        preparedSpec.installSpec,
        selectedRuntime.version,
        "global install runtime guard",
        expectedInstalledVersion,
      );
      steps.push(runtimeGuardStep);
      if (runtimeGuardStep.exitCode !== 0) {
        return {
          steps,
          verifiedPackageRoot: params.packageRoot ?? params.installTarget.packageRoot,
          afterVersion: await readPackageVersionIfPresent(
            params.packageRoot ?? params.installTarget.packageRoot,
          ),
          failedStep: runtimeGuardStep,
        };
      }
    }

    // Keep npm's global destination stable when the packed source is an aliased fork.
    // npm-package-arg owns file-path encoding; pre-encoding makes spaces resolve as literal %20.
    const activationInstallSpec =
      preparedSpec.packDir && installCommandTarget.manager === "npm"
        ? `${params.packageName}@file:${preparedSpec.installSpec}`
        : preparedSpec.installSpec;

    const installLocation =
      stagedInstall?.prefix ??
      (installCommandTarget.manager === "pnpm"
        ? resolvePnpmGlobalDirFromGlobalRoot(installCommandTarget.globalRoot)
        : null);
    const updateStep = await params.runStep({
      name: "global update",
      argv: globalInstallArgs(
        installCommandTarget,
        activationInstallSpec,
        undefined,
        installLocation,
      ),
      ...installCwd,
      ...(updateEnv === undefined ? {} : { env: updateEnv }),
      timeoutMs: params.timeoutMs,
    });

    steps.push(updateStep);
    let finalInstallStep = updateStep;
    if (updateStep.exitCode !== 0) {
      await cleanupStagedNpmInstall(stagedInstall);
      stagedInstall = null;
      const preparedFallbackInstall = await prepareStagedNpmInstall(
        params.installTarget,
        params.packageName,
      );
      stagedInstall = preparedFallbackInstall.stagedInstall;
      if (preparedFallbackInstall.failedStep) {
        steps.push(preparedFallbackInstall.failedStep);
        return {
          steps,
          verifiedPackageRoot: params.packageRoot ?? null,
          afterVersion: null,
          failedStep: preparedFallbackInstall.failedStep,
        };
      }

      const fallbackArgv = globalInstallFallbackArgs(
        stagedInstall?.installTarget ?? params.installTarget,
        activationInstallSpec,
        undefined,
        stagedInstall?.prefix,
      );
      if (fallbackArgv) {
        const fallbackStep = await params.runStep({
          name: "global update (omit optional)",
          argv: fallbackArgv,
          ...installCwd,
          ...(updateEnv === undefined ? {} : { env: updateEnv }),
          timeoutMs: params.timeoutMs,
        });
        steps.push(fallbackStep);
        finalInstallStep = fallbackStep;
      } else {
        await cleanupStagedNpmInstall(stagedInstall);
        stagedInstall = null;
      }
    }

    const livePackageRoot =
      params.installTarget.packageRoot ??
      params.packageRoot ??
      (
        await resolveGlobalInstallTarget({
          manager: params.installTarget,
          runCommand: params.runCommand,
          timeoutMs: params.timeoutMs,
        })
      ).packageRoot ??
      null;
    const manualLifecyclePackageRoot =
      stagedInstall?.packageRoot ??
      (params.installTarget.manager === "npm" ? livePackageRoot : null);
    // npm installs with dependency scripts disabled. Validate and run only OpenClaw's trusted
    // root lifecycle before verification, whether the destination is staged or direct.
    if (finalInstallStep.exitCode === 0 && manualLifecyclePackageRoot) {
      const lifecycle = await runPackageInstallLifecycle({
        packageRoot: manualLifecyclePackageRoot,
        runStep: params.runStep,
        timeoutMs: params.timeoutMs,
        ...(updateEnv === undefined ? {} : { env: updateEnv }),
        runtimeVersion: selectedRuntime.version,
        ...(selectedRuntime.nodePath === null ? {} : { nodePath: selectedRuntime.nodePath }),
        allowMissingGuardForVersion: expectedInstalledVersion,
      });
      steps.push(...lifecycle.steps);
      finalInstallStep = lifecycle.failedStep ?? finalInstallStep;
    }

    const verificationPackageRoot = stagedInstall?.packageRoot ?? livePackageRoot;
    let verifiedPackageRoot = livePackageRoot ?? verificationPackageRoot;

    let afterVersion: string | null = null;
    if (stagedInstall && finalInstallStep.exitCode !== 0) {
      afterVersion = await readPackageVersionIfPresent(livePackageRoot);
    }
    if (finalInstallStep.exitCode === 0 && verificationPackageRoot) {
      const candidateVersion = await readPackageVersion(verificationPackageRoot);
      if (!stagedInstall) {
        afterVersion = candidateVersion;
      }
      const verificationErrors = await collectInstalledGlobalPackageErrors({
        packageRoot: verificationPackageRoot,
        expectedVersion: expectedInstalledVersion,
      });
      if (verificationErrors.length > 0) {
        steps.push({
          name: "global install verify",
          command: `verify ${verificationPackageRoot}`,
          cwd: verificationPackageRoot,
          durationMs: 0,
          exitCode: 1,
          stderrTail: verificationErrors.join("\n"),
          stdoutTail: null,
        });
      }

      if (stagedInstall && verificationErrors.length === 0) {
        const swapStep = await swapStagedNpmInstall({
          stage: stagedInstall,
          installTarget: params.installTarget,
          packageName: params.packageName,
        });
        steps.push(swapStep);
        if (swapStep.exitCode === 0) {
          verifiedPackageRoot = params.installTarget.packageRoot ?? verifiedPackageRoot;
          afterVersion = candidateVersion;
        }
      }

      const failedVerifyOrSwap = steps.find(
        (step) =>
          (step.name === "global install verify" || step.name === "global install swap") &&
          step.exitCode !== 0,
      );
      const postVerifyStep = failedVerifyOrSwap
        ? null
        : verifiedPackageRoot
          ? await params.postVerifyStep?.(verifiedPackageRoot)
          : null;
      if (postVerifyStep) {
        steps.push(postVerifyStep);
      }
      if (failedVerifyOrSwap && stagedInstall) {
        afterVersion = await readPackageVersionIfPresent(livePackageRoot);
      }
    }

    const failedStep = isBlockingPackageUpdateStep(finalInstallStep)
      ? finalInstallStep
      : (steps.find((step) => step !== updateStep && isBlockingPackageUpdateStep(step)) ?? null);

    return {
      steps,
      verifiedPackageRoot,
      afterVersion,
      failedStep,
    };
  } finally {
    await cleanupStagedNpmInstall(stagedInstall ?? null);
    if (packedInstallDir) {
      await removePathBestEffort(packedInstallDir);
    }
  }
}
