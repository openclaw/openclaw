// Runs package update move, inventory, and cleanup steps.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathExists } from "./fs-safe.js";
import { collectPackageDistContentInventoryErrors } from "./package-dist-inventory.js";
import { readPackageVersion } from "./package-json.js";
import {
  applyLocalPackageOverrides,
  captureLocalPackageOverrides,
  type LocalPackageOverridesPlan,
  type LocalPackageOverridesResult,
} from "./package-local-overrides.js";
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

/**
 * Captures one package-manager or filesystem step from the global update flow.
 * Callers surface these records directly in update diagnostics.
 */
export type PackageUpdateStepResult = {
  name: string;
  command: string;
  cwd: string;
  durationMs: number;
  exitCode: number | null;
  stdoutTail?: string | null;
  stderrTail?: string | null;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
  termination?: "exit" | "timeout" | "no-output-timeout" | "signal";
  advisory?: PackageUpdateStepAdvisory;
};

type PackageUpdateStepRunner = (params: {
  name: string;
  argv: string[];
  cwd?: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}) => Promise<PackageUpdateStepResult>;

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

const NPM_PACK_QUIET_FLAGS = ["--json", "--loglevel=error"] as const;

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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

function stripPackageAlias(spec: string, packageName: string): string {
  const trimmed = spec.trim();
  const prefix = `${packageName.trim()}@`;
  return trimmed.toLowerCase().startsWith(prefix.toLowerCase())
    ? trimmed.slice(prefix.length).trim()
    : trimmed;
}

function isHttpGitUrlSpec(spec: string): boolean {
  try {
    const url = new URL(spec);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return false;
    }
    const pathname = url.pathname.replace(/\/+$/u, "");
    if (pathname.endsWith(".git")) {
      return true;
    }
    const parts = pathname.split("/").filter(Boolean);
    return url.hostname.toLowerCase() === "github.com" && parts.length === 2;
  } catch {
    return false;
  }
}

function isGitHubShorthandSpec(spec: string): boolean {
  const [repo] = spec.split("#", 1);
  if (!repo || repo.startsWith(".") || repo.startsWith("/") || repo.startsWith("@")) {
    return false;
  }
  const parts = repo.split("/");
  return parts.length === 2 && parts.every((part) => /^[^\s/:@]+$/u.test(part));
}

function isNpmGitSourceInstallSpec(spec: string, packageName: string): boolean {
  const target = stripPackageAlias(spec, packageName);
  return (
    /^github:/i.test(target) ||
    /^git\+(?:ssh|https|http|file):/i.test(target) ||
    /^git:/i.test(target) ||
    /^ssh:\/\//i.test(target) ||
    /^[^@\s]+@[^:\s]+:[^#\s]+(?:#.*)?$/u.test(target) ||
    isHttpGitUrlSpec(target) ||
    isGitHubShorthandSpec(target)
  );
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

async function findPackedTarball(packDir: string): Promise<string | null> {
  const entries = await fs.readdir(packDir).catch((): string[] => []);
  const tarballs = entries.filter((entry) => entry.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    return null;
  }
  return path.join(packDir, tarballs[0] ?? "");
}

async function prepareNpmGitSourceInstallSpec(params: {
  installTarget: ResolvedGlobalInstallTarget;
  installSpec: string;
  packageName: string;
  runStep: PackageUpdateStepRunner;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  installCwd?: string;
}): Promise<{
  installSpec: string;
  packDir: string | null;
  steps: PackageUpdateStepResult[];
  failedStep: PackageUpdateStepResult | null;
}> {
  if (
    params.installTarget.manager !== "npm" ||
    !isNpmGitSourceInstallSpec(params.installSpec, params.packageName)
  ) {
    return { installSpec: params.installSpec, packDir: null, steps: [], failedStep: null };
  }

  const packDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-pack-"));
  const packStep = await params.runStep({
    name: "global update pack",
    argv: [
      params.installTarget.command,
      "pack",
      params.installSpec,
      "--pack-destination",
      packDir,
      ...NPM_PACK_QUIET_FLAGS,
    ],
    cwd: params.installCwd,
    env: params.env,
    timeoutMs: params.timeoutMs,
  });
  if (packStep.exitCode !== 0) {
    return {
      installSpec: params.installSpec,
      packDir,
      steps: [packStep],
      failedStep: packStep,
    };
  }

  const tarball = await findPackedTarball(packDir);
  if (!tarball) {
    const failedStep: PackageUpdateStepResult = {
      name: "global update pack verify",
      command: `find packed tarball in ${packDir}`,
      cwd: packDir,
      durationMs: 0,
      exitCode: 1,
      stdoutTail: null,
      stderrTail: `expected exactly one .tgz from npm pack ${params.installSpec}`,
    };
    return {
      installSpec: params.installSpec,
      packDir,
      steps: [packStep, failedStep],
      failedStep,
    };
  }

  return {
    installSpec: tarball,
    packDir,
    steps: [packStep],
    failedStep: null,
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
    const targetLayout =
      installTarget.manager === "npm"
        ? resolveNpmGlobalPrefixLayoutFromGlobalRoot(installTarget.globalRoot, {
            allowDirectNodeModulesRoot: installTarget.directNodeModulesRoot === true,
          })
        : null;
    return {
      stagedInstall: null,
      failedStep: {
        name: "global install stage",
        command: "prepare staged npm install",
        cwd: targetLayout?.prefix ?? installTarget.globalRoot ?? process.cwd(),
        durationMs: Date.now() - startedAt,
        exitCode: 1,
        stdoutTail: null,
        stderrTail: formatError(err),
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

function pushLocalOverridesStep(params: {
  steps: PackageUpdateStepResult[];
  packageRoot: string;
  localOverrides: LocalPackageOverridesResult;
}): void {
  if (params.localOverrides.status === "none") {
    return;
  }
  const diagnosticLines = [
    params.localOverrides.recoveryDir
      ? `preserved local override recovery bundle: ${params.localOverrides.recoveryDir}`
      : null,
    ...params.localOverrides.warnings,
    ...params.localOverrides.conflicts.map((conflict) => `${conflict.path}: ${conflict.reason}`),
  ].filter((line): line is string => Boolean(line));
  params.steps.push({
    name: "local overrides",
    command: `reapply local OpenClaw changes in ${params.packageRoot}`,
    cwd: params.packageRoot,
    durationMs: 0,
    exitCode: params.localOverrides.status === "error" ? 1 : 0,
    stdoutTail:
      params.localOverrides.status === "applied"
        ? `reapplied ${params.localOverrides.applied} local override(s)`
        : null,
    stderrTail: diagnosticLines.length > 0 ? diagnosticLines.join("\n") : null,
  });
}

type LocalPackageOverridesCaptureResult =
  | { status: "captured"; plan: LocalPackageOverridesPlan | null }
  | { status: "error"; failedStep: PackageUpdateStepResult };

function createLocalOverridesFailureStep(params: {
  packageRoot: string;
  command: string;
  message: string;
  durationMs: number;
}): PackageUpdateStepResult {
  return {
    name: "local overrides",
    command: params.command,
    cwd: params.packageRoot,
    durationMs: params.durationMs,
    exitCode: 1,
    stdoutTail: null,
    stderrTail: params.message,
  };
}

async function captureLocalPackageOverridesForUpdate(
  packageRoot: string,
  recordedPackageRoot = packageRoot,
): Promise<LocalPackageOverridesCaptureResult> {
  const startedAt = Date.now();
  try {
    return {
      status: "captured",
      plan: await captureLocalPackageOverrides({ packageRoot, recordedPackageRoot }),
    };
  } catch (error) {
    return {
      status: "error",
      failedStep: createLocalOverridesFailureStep({
        packageRoot: recordedPackageRoot,
        command: `inspect local OpenClaw changes in ${recordedPackageRoot}`,
        durationMs: Date.now() - startedAt,
        message: `Local OpenClaw changes could not be inspected safely before update: ${formatError(error)}`,
      }),
    };
  }
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
}): Promise<{
  step: PackageUpdateStepResult;
  capturedLocalOverrides: LocalPackageOverridesCaptureResult;
}> {
  const startedAt = Date.now();
  let capturedLocalOverrides: LocalPackageOverridesCaptureResult = {
    status: "captured",
    plan: null,
  };
  const targetLayout = resolveNpmGlobalPrefixLayoutFromGlobalRoot(params.installTarget.globalRoot, {
    allowDirectNodeModulesRoot: params.installTarget.directNodeModulesRoot === true,
  });
  const targetPackageRoot = params.installTarget.packageRoot;
  if (!targetLayout || !targetPackageRoot) {
    return {
      step: {
        name: "global install swap",
        command: "swap staged npm install",
        cwd: params.stage.prefix,
        durationMs: Date.now() - startedAt,
        exitCode: 1,
        stdoutTail: null,
        stderrTail: "cannot resolve npm global prefix layout",
      },
      capturedLocalOverrides,
    };
  }

  const backupRoot = path.join(targetLayout.globalRoot, `.openclaw-${process.pid}-${Date.now()}`);
  let movedExisting = false;
  let movedStaged = false;
  let removedBackup = true;
  let captureFailedStep: PackageUpdateStepResult | null = null;
  try {
    await fs.mkdir(targetLayout.globalRoot, { recursive: true });
    if (await pathExists(targetPackageRoot)) {
      await movePathWithCopyFallback({
        from: targetPackageRoot,
        sourceHardlinks: PACKAGE_MANAGER_SWAP_SOURCE_HARDLINKS,
        to: backupRoot,
      });
      movedExisting = true;
      capturedLocalOverrides = await captureLocalPackageOverridesForUpdate(
        backupRoot,
        targetPackageRoot,
      );
      if (capturedLocalOverrides.status === "error") {
        captureFailedStep = capturedLocalOverrides.failedStep;
        throw new Error(captureFailedStep.stderrTail ?? "local override capture failed");
      }
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
      step: {
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
      },
      capturedLocalOverrides,
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
      step: captureFailedStep ?? {
        name: "global install swap",
        command: `swap ${params.stage.packageRoot} -> ${targetPackageRoot}`,
        cwd: targetLayout.globalRoot,
        durationMs: Date.now() - startedAt,
        exitCode: 1,
        stdoutTail: null,
        stderrTail: formatError(err),
      },
      capturedLocalOverrides,
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
  reapplyLocalOverrides?: boolean;
  postVerifyStep?: (packageRoot: string) => Promise<PackageUpdateStepResult | null>;
}): Promise<{
  steps: PackageUpdateStepResult[];
  verifiedPackageRoot: string | null;
  afterVersion: string | null;
  failedStep: PackageUpdateStepResult | null;
  localOverrides?: LocalPackageOverridesResult;
}> {
  const installCwd = params.installCwd === undefined ? {} : { cwd: params.installCwd };
  const installEnv = params.env === undefined ? {} : { env: params.env };
  let stagedInstall: StagedNpmInstall | null | undefined;
  let packedInstallDir: string | null = null;
  let localOverrides: LocalPackageOverridesResult | undefined;

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
    let preUpdateLocalOverridesPlan: LocalPackageOverridesPlan | null = null;
    if (livePackageRoot) {
      // Preflight capture before package-manager work so unsafe installed inventory
      // cannot turn an in-place update into unrecoverable executable content loss.
      const capturedLocalOverrides = await captureLocalPackageOverridesForUpdate(livePackageRoot);
      if (capturedLocalOverrides.status === "error") {
        return {
          steps: [capturedLocalOverrides.failedStep],
          verifiedPackageRoot: livePackageRoot,
          afterVersion: null,
          failedStep: capturedLocalOverrides.failedStep,
        };
      }
      if (stagedInstall && capturedLocalOverrides.plan) {
        // Staged installs recapture immediately before swap so the preserved plan
        // includes edits made while the candidate package was being prepared.
        const cleanupStartedAt = Date.now();
        if (!(await removePathBestEffort(capturedLocalOverrides.plan.recoveryDir))) {
          const failedStep = createLocalOverridesFailureStep({
            packageRoot: livePackageRoot,
            command: `discard staged preflight local OpenClaw changes in ${livePackageRoot}`,
            durationMs: Date.now() - cleanupStartedAt,
            message: `Local OpenClaw changes were inspected before update, but the temporary recovery bundle could not be removed: ${capturedLocalOverrides.plan.recoveryDir}`,
          });
          return {
            steps: [failedStep],
            verifiedPackageRoot: livePackageRoot,
            afterVersion: null,
            failedStep,
          };
        }
      } else {
        preUpdateLocalOverridesPlan = capturedLocalOverrides.plan;
      }
    }
    const installCommandTarget = stagedInstall?.installTarget ?? params.installTarget;
    const preparedSpec = await prepareNpmGitSourceInstallSpec({
      installTarget: installCommandTarget,
      installSpec: params.installSpec,
      packageName: params.packageName,
      runStep: params.runStep,
      timeoutMs: params.timeoutMs,
      env: params.env,
      installCwd: params.installCwd,
    });
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

    const installLocation =
      stagedInstall?.prefix ??
      (installCommandTarget.manager === "pnpm"
        ? resolvePnpmGlobalDirFromGlobalRoot(installCommandTarget.globalRoot)
        : null);
    const updateStep = await params.runStep({
      name: "global update",
      argv: globalInstallArgs(
        installCommandTarget,
        preparedSpec.installSpec,
        undefined,
        installLocation,
      ),
      ...installCwd,
      ...installEnv,
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
        preparedSpec.installSpec,
        undefined,
        stagedInstall?.prefix,
      );
      if (fallbackArgv) {
        const fallbackStep = await params.runStep({
          name: "global update (omit optional)",
          argv: fallbackArgv,
          ...installCwd,
          ...installEnv,
          timeoutMs: params.timeoutMs,
        });
        steps.push(fallbackStep);
        finalInstallStep = fallbackStep;
      } else {
        await cleanupStagedNpmInstall(stagedInstall);
        stagedInstall = null;
      }
    }

    const verificationPackageRoot = stagedInstall?.packageRoot ?? livePackageRoot;
    let verifiedPackageRoot = livePackageRoot ?? verificationPackageRoot;
    const preservePreUpdateLocalOverrides = async () => {
      if (localOverrides || !livePackageRoot) {
        return;
      }
      localOverrides = await applyLocalPackageOverrides({
        packageRoot: livePackageRoot,
        plan: preUpdateLocalOverridesPlan,
        reapply: false,
      });
      pushLocalOverridesStep({
        steps,
        packageRoot: livePackageRoot,
        localOverrides,
      });
    };

    let afterVersion: string | null = null;
    if (finalInstallStep.exitCode === 0 && verificationPackageRoot) {
      const candidateVersion = await readPackageVersion(verificationPackageRoot);
      if (!stagedInstall) {
        afterVersion = candidateVersion;
      }
      const expectedVersion = resolveExpectedInstalledVersionFromSpec(
        params.packageName,
        params.installSpec,
      );
      const verificationErrors = await collectInstalledGlobalPackageErrors({
        packageRoot: verificationPackageRoot,
        expectedVersion,
      });
      try {
        verificationErrors.push(
          ...(await collectPackageDistContentInventoryErrors(verificationPackageRoot)),
        );
      } catch (error) {
        verificationErrors.push(formatError(error));
      }
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
      if (!stagedInstall && verificationErrors.length > 0 && livePackageRoot) {
        localOverrides = await applyLocalPackageOverrides({
          packageRoot: livePackageRoot,
          plan: preUpdateLocalOverridesPlan,
          reapply: false,
        });
        pushLocalOverridesStep({ steps, packageRoot: livePackageRoot, localOverrides });
      }

      if (stagedInstall && verificationErrors.length === 0) {
        const swapResult = await swapStagedNpmInstall({
          stage: stagedInstall,
          installTarget: params.installTarget,
          packageName: params.packageName,
        });
        steps.push(swapResult.step);
        if (swapResult.capturedLocalOverrides.status === "error") {
          afterVersion = await readPackageVersionIfPresent(livePackageRoot);
        } else if (swapResult.step.exitCode === 0) {
          const activePackageRoot = params.installTarget.packageRoot ?? verifiedPackageRoot;
          verifiedPackageRoot = activePackageRoot;
          afterVersion = candidateVersion;
          if (activePackageRoot) {
            localOverrides = await applyLocalPackageOverrides({
              packageRoot: activePackageRoot,
              plan: swapResult.capturedLocalOverrides.plan,
              reapply: params.reapplyLocalOverrides === true,
            });
            pushLocalOverridesStep({ steps, packageRoot: activePackageRoot, localOverrides });
          }
        } else if (livePackageRoot) {
          localOverrides = await applyLocalPackageOverrides({
            packageRoot: livePackageRoot,
            plan: swapResult.capturedLocalOverrides.plan,
            reapply: false,
          });
          pushLocalOverridesStep({ steps, packageRoot: livePackageRoot, localOverrides });
        }
      } else if (!stagedInstall && verificationErrors.length === 0 && livePackageRoot) {
        localOverrides = await applyLocalPackageOverrides({
          packageRoot: livePackageRoot,
          plan: preUpdateLocalOverridesPlan,
          reapply: params.reapplyLocalOverrides === true,
        });
        pushLocalOverridesStep({ steps, packageRoot: livePackageRoot, localOverrides });
      }

      const failedPrePostVerifyStep = steps.find(
        (step) => step !== updateStep && step.exitCode !== 0,
      );
      const postVerifyStep = failedPrePostVerifyStep
        ? null
        : verifiedPackageRoot
          ? await params.postVerifyStep?.(verifiedPackageRoot)
          : null;
      if (postVerifyStep) {
        steps.push(postVerifyStep);
      }
      if (
        failedPrePostVerifyStep &&
        stagedInstall &&
        (failedPrePostVerifyStep.name === "global install verify" ||
          failedPrePostVerifyStep.name === "global install swap")
      ) {
        afterVersion = await readPackageVersionIfPresent(livePackageRoot);
      }
    }
    if (finalInstallStep.exitCode !== 0) {
      await preservePreUpdateLocalOverrides();
    }

    const failedStep = isBlockingPackageUpdateStep(finalInstallStep)
      ? finalInstallStep
      : (steps.find((step) => step !== updateStep && isBlockingPackageUpdateStep(step)) ?? null);

    return {
      steps,
      verifiedPackageRoot,
      afterVersion,
      failedStep,
      localOverrides,
    };
  } finally {
    await cleanupStagedNpmInstall(stagedInstall ?? null);
    if (packedInstallDir) {
      await removePathBestEffort(packedInstallDir);
    }
  }
}
