// Runs package update move, inventory, and cleanup steps.
import fs from "node:fs/promises";
import path from "node:path";
import { validRange } from "semver";
import { LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH } from "../../scripts/lib/package-lifecycle-marker.mjs";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { UPDATE_GLOBAL_PERMISSION_REASON } from "../shared/update-outcome.js";
import { resolveBunGlobalInstallOwner } from "./detect-package-manager.js";
import { formatErrorMessage } from "./errors.js";
import { resolveInstallWorkTimeoutMs } from "./install-mode-options.js";
import { collectPackageDistContentInventoryErrors } from "./package-dist-inventory.js";
import { readPackageVersion } from "./package-json.js";
import type { LocalPackageOverridesResult } from "./package-local-overrides.js";
import { readPackageVersionIfPresent } from "./package-update-integrity.js";
import type { PackageUpdateStepRunner } from "./package-update-lifecycle.js";
import {
  discardPackageUpdateStage,
  resolveNpmUpdateLifecyclePolicy,
  runPackageUpdateLifecycle,
  verifyUnchangedPackageUpdateRecovery,
} from "./package-update-lifecycle.js";
import {
  checkGlobalPackageUpdatePermissions,
  classifyPackageUpdatePermissionFailure,
  resolveCanonicalPath,
  runPnpmPreflightProbe,
  validatePnpmIsolatedUpdate,
} from "./package-update-manager-preflight.js";
import { prepareNpmGitSourceInstallSpec } from "./package-update-npm-pack.js";
import {
  PackageUpdateActivationError,
  removePackageUpdatePath,
  swapStagedPackageInstall,
  type PackageUpdateTransaction,
  type StagedPackageInstall,
} from "./package-update-swap.js";
import {
  createPackageVerificationFailureStep,
  type PackagePostInstallVerifier,
} from "./package-update-verification-step.js";
import { createUpdateFailureFact } from "./update-failure-facts.js";
import {
  createFreeBsdPkgOwnershipInspection,
  FreeBsdPkgOwnershipError,
} from "./update-freebsd-pkg-ownership.js";
import { readBuiltGatewayBuildId, type GitRuntimeIdentity } from "./update-git-runtime.js";
import type { CommandRunner } from "./update-global-command-runner.js";
import {
  collectInstalledGlobalPackageErrors,
  cleanupGlobalRenameDirs,
  globalInstallArgs,
  globalInstallFallbackArgs,
  listActivePnpmIsolatedGlobalPackages,
  resolveExpectedInstalledVersionFromSpec,
  verifyPackageUpdateRecovery,
  type ResolvedGlobalInstallTarget,
} from "./update-global.js";
import { resolvePnpmGlobalDirFromGlobalRoot } from "./update-native-package-owner.js";
import {
  prepareNativePackageStage,
  resolveNativeInstallSpecFromCwd,
} from "./update-native-package-stage.js";
import {
  readPackageManagerProbeValue,
  resolveNpmGlobalPrefixLayoutFromGlobalRoot,
  resolveNpmGlobalPrefixLayoutFromPrefix,
} from "./update-npm-prefix.js";
import type { UpdateRecovery } from "./update-recovery.js";
import { isFailedUpdateStep } from "./update-run-step.js";
import type { UpdateStepResult } from "./update-step-result.js";
export type { PackageUpdateTransaction } from "./package-update-swap.js";

type PackageUpdateStepsResult = {
  localOverrides?: LocalPackageOverridesResult;
  reason?: "already-current" | typeof UPDATE_GLOBAL_PERMISSION_REASON;
  steps: UpdateStepResult[];
  activePackageRoot: string | null;
  afterVersion: string | null;
  failedStep: UpdateStepResult | null;
  recovery: UpdateRecovery;
};

function isRegistrySourceInstallSpec(spec: string): boolean {
  // Version-only deduplication is reserved for positively identified registry
  // specs. Explicit and unknown npm source syntax must prove build identity.
  // npm-package-arg gives unscoped archive names precedence over package names.
  const archive = /[.](?:tgz|tar[.]gz|tar)$/iu;
  const packageName = /^(?:@[a-z0-9_][a-z0-9._-]*\/)?[a-z0-9_][a-z0-9._-]*$/iu;
  const value = spec.trim();
  const separator = value.indexOf("@", 1);
  const name = separator > 0 ? value.slice(0, separator) : value;
  const selector = separator > 0 ? value.slice(separator + 1).trim() : "";

  if (value.startsWith("npm:") || selector.startsWith("npm:")) {
    // An alias can replace the underlying package at the same version.
    return false;
  }
  if (!packageName.test(name) || (!name.startsWith("@") && archive.test(name))) {
    return false;
  }
  // File suffixes take precedence over dist-tags in npm's resolve contract.
  // npm treats leading dots as paths and accepts tags unchanged by encodeURIComponent.
  return (
    !selector.startsWith(".") &&
    !archive.test(selector) &&
    (validRange(selector, true) !== null || encodeURIComponent(selector) === selector)
  );
}

async function createStagedPackageInstall(
  installTarget: ResolvedGlobalInstallTarget,
  packageName: string,
): Promise<StagedPackageInstall> {
  const targetLayout = resolveNpmGlobalPrefixLayoutFromGlobalRoot(installTarget.globalRoot, {
    allowDirectNodeModulesRoot: installTarget.directNodeModulesRoot === true,
  });
  if (!targetLayout) {
    throw new Error(
      `The ${installTarget.manager} global install layout cannot prepare the update. Reinstall with ${installTarget.manager} into its default global layout, then retry the update.`,
    );
  }
  await fs.mkdir(targetLayout.globalRoot, { recursive: true });
  // Active stages must stay outside cleanupGlobalRenameDirs' disposable ".openclaw-" namespace.
  const prefix = await fs.mkdtemp(path.join(targetLayout.globalRoot, ".openclaw.update-stage-"));
  const layout = resolveNpmGlobalPrefixLayoutFromPrefix(prefix);
  return {
    prefix,
    layout,
    packageRoot: path.join(layout.globalRoot, packageName),
    installTarget: {
      manager: "npm",
      command: installTarget.command,
      globalRoot: layout.globalRoot,
      packageRoot: path.join(layout.globalRoot, packageName),
    },
  };
}

async function prepareStagedPackageInstall(
  installTarget: ResolvedGlobalInstallTarget,
  packageName: string,
  nativeOptions?: { env: NodeJS.ProcessEnv; globalBinDir?: string; installSpec: string },
): Promise<
  | { stagedInstall: StagedPackageInstall; failedStep: null }
  | { stagedInstall: null; failedStep: UpdateStepResult }
> {
  const startedAt = Date.now();
  try {
    if (nativeOptions) {
      const native = await prepareNativePackageStage({
        installTarget,
        packageName,
        ...nativeOptions,
      });
      if (!native) {
        throw new Error("Cannot resolve the native package manager's staging owner.");
      }
      // Isolated pnpm resolves its newly created owner after installation.
      const packageRoot = path.join(native.globalRoot, packageName);
      return {
        stagedInstall: {
          prefix: native.projectRoot,
          layout: {
            prefix: native.projectRoot,
            globalRoot: native.globalRoot,
            binDir: native.binDir,
          },
          packageRoot,
          installTarget: { ...installTarget, globalRoot: native.globalRoot, packageRoot },
          native,
        },
        failedStep: null,
      };
    }
    return {
      stagedInstall: await createStagedPackageInstall(installTarget, packageName),
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
      failedStep: await classifyPackageUpdatePermissionFailure(
        {
          name: "package-stage",
          command: `prepare staged ${installTarget.manager} install`,
          cwd: targetLayout?.prefix ?? installTarget.globalRoot ?? process.cwd(),
          durationMs: Date.now() - startedAt,
          exitCode: 1,
          stdoutTail: null,
          stderrTail: formatErrorMessage(err),
        },
        installTarget,
        nativeOptions?.env,
        err,
      ),
    };
  }
}

/**
 * Stages and verifies a global package update before the swap owner publishes it.
 */
export async function runGlobalPackageUpdateSteps(params: {
  installTarget: ResolvedGlobalInstallTarget;
  installSpec: string;
  packageName: string;
  packageRoot?: string | null;
  requirePackageReplacement?: boolean;
  runCommand: CommandRunner;
  runStep: PackageUpdateStepRunner;
  timeoutMs: number;
  /** Null leaves forward work unbounded; omission retains the caller's timeout. */
  workTimeoutMs?: number | null;
  env?: NodeJS.ProcessEnv;
  installCwd?: string;
  postVerifyStep?: PackagePostInstallVerifier;
  beforeVerifyCandidate?: (packageRoot: string) => Promise<void>;
  resolveLifecycleNodeRunner?: () => string | undefined;
  validateCandidate?: (packageRoot: string) => Promise<UpdateStepResult[]>;
  beforeActivate?: () => Promise<void>;
  assertCurrent?: () => void;
  onTransaction?: (transaction: PackageUpdateTransaction) => void;
  expectedGitCheckout?: GitRuntimeIdentity;
  activateGitRoot?: string;
  localOverrides?: { reapply: boolean; env?: NodeJS.ProcessEnv };
}): Promise<PackageUpdateStepsResult> {
  const workTimeoutMs = resolveInstallWorkTimeoutMs(params.workTimeoutMs, params.timeoutMs);
  let localOverrides: LocalPackageOverridesResult | undefined;
  let stagedInstall: StagedPackageInstall | null = null;
  let uncertainLifecycleStage: StagedPackageInstall | null = null;
  let packedInstallDir: string | null = null;
  const originalPackageRoot = params.installTarget.packageRoot ?? params.packageRoot ?? null;
  let activePackageRoot = originalPackageRoot;
  let afterVersion: string | null = null;
  const initialRecovery = await verifyPackageUpdateRecovery(originalPackageRoot);
  let liveTreeMutated = false;
  let committed = false;
  let cleanupUncertain = false;
  let packageRollbackVerified: boolean | undefined;
  const steps: UpdateStepResult[] = [];
  const cleanupStage = async (): Promise<UpdateStepResult | null> => {
    if (!stagedInstall || stagedInstall === uncertainLifecycleStage) {
      return null;
    }
    const cleanup = await discardPackageUpdateStage({
      stage: stagedInstall,
      manager: params.installTarget.manager,
      committed,
    });
    if (cleanup.status === "failed") {
      uncertainLifecycleStage = stagedInstall;
      return cleanup.step;
    }
    if (cleanup.status === "advisory") {
      steps.push(cleanup.step);
    }
    stagedInstall = null;
    return null;
  };
  const packageUpdateFailure = async (
    failedStep: UpdateStepResult,
    failedSteps = [failedStep],
  ): Promise<PackageUpdateStepsResult> => {
    const cleanupFailure = await cleanupStage();
    const finalFailedStep = cleanupFailure ?? failedStep;
    const finalFailedSteps = cleanupFailure ? [...failedSteps, cleanupFailure] : failedSteps;
    finalFailedStep.failureFacts ??= [
      createUpdateFailureFact(
        {
          check: finalFailedStep.name,
          code: "global-install-failed",
          message: finalFailedStep.stderrTail ?? undefined,
        },
        params.env,
      ),
    ];
    const recovery: UpdateRecovery = liveTreeMutated
      ? {
          serviceRestartSafe: false,
          reason: "runtime-verification-failed",
          ...(packageRollbackVerified === undefined ? {} : { packageRollbackVerified }),
        }
      : await verifyUnchangedPackageUpdateRecovery(originalPackageRoot, initialRecovery);
    return {
      localOverrides,
      ...(finalFailedStep.failureFacts?.some(
        (fact) => fact.code === UPDATE_GLOBAL_PERMISSION_REASON,
      )
        ? { reason: UPDATE_GLOBAL_PERMISSION_REASON }
        : {}),
      steps: finalFailedSteps,
      activePackageRoot,
      afterVersion,
      failedStep: finalFailedStep,
      recovery,
    };
  };

  try {
    const permissions = await checkGlobalPackageUpdatePermissions(params.installTarget, params.env);
    if (permissions) {
      return await packageUpdateFailure(permissions);
    }
    if (process.platform === "freebsd") {
      if (!params.installTarget.packageRoot) {
        throw new FreeBsdPkgOwnershipError("pkg-ownership-unavailable", "paths");
      }
      const inspection = createFreeBsdPkgOwnershipInspection(params.timeoutMs);
      await inspection.assertUnowned(params.packageRoot);
      await inspection.assertUnowned(params.installTarget.packageRoot);
    }
    const npmPreflight = await resolveNpmUpdateLifecyclePolicy({
      installTarget: params.installTarget,
    });
    if (npmPreflight.failedStep) {
      return await packageUpdateFailure(npmPreflight.failedStep);
    }
    const pnpmPreflight = await validatePnpmIsolatedUpdate({
      installTarget: params.installTarget,
      packageName: params.packageName,
      runCommand: params.runCommand,
      timeoutMs: params.timeoutMs,
      env: params.env,
    });
    if (pnpmPreflight.failedStep) {
      return await packageUpdateFailure(pnpmPreflight.failedStep);
    }
    const packageRoot = params.packageRoot ?? params.installTarget.packageRoot;
    if (packageRoot && !params.beforeVerifyCandidate) {
      // Lifecycle policy must refuse before cleanup can remove an interrupted update backup.
      await cleanupGlobalRenameDirs({
        globalRoot: path.dirname(packageRoot),
        packageName: params.packageName,
      });
    }
    const bunOwner =
      params.installTarget.manager === "bun"
        ? resolveBunGlobalInstallOwner(
            params.installTarget.packageRoot ?? params.packageRoot,
            params.env ?? process.env,
          )
        : null;
    // Bun's global project follows its environment, not the selected binary.
    // Bind the mutation to the verified owner even when service settings drift.
    let effectiveInstallEnv =
      params.installTarget.manager === "bun" && params.installTarget.globalRoot
        ? {
            ...(params.env ?? process.env),
            BUN_INSTALL_GLOBAL_DIR: path.dirname(params.installTarget.globalRoot),
            ...(bunOwner?.bunInstall ? { BUN_INSTALL: bunOwner.bunInstall } : {}),
          }
        : params.env;
    if (params.installTarget.manager === "pnpm" && params.installTarget.globalRoot) {
      const globalDir = resolvePnpmGlobalDirFromGlobalRoot(params.installTarget.globalRoot);
      // Bind verified paths through both pnpm configuration dialects, in both
      // cases, after original-env probes so inherited aliases cannot redirect it.
      // pnpm 11 keeps its already-probed config and cwd.
      effectiveInstallEnv = {
        ...(params.env ?? process.env),
        ...(globalDir
          ? {
              pnpm_config_global_dir: globalDir,
              PNPM_CONFIG_GLOBAL_DIR: globalDir,
              npm_config_global_dir: globalDir,
              NPM_CONFIG_GLOBAL_DIR: globalDir,
            }
          : {}),
        ...(pnpmPreflight.globalBinDir
          ? {
              pnpm_config_global_bin_dir: pnpmPreflight.globalBinDir,
              PNPM_CONFIG_GLOBAL_BIN_DIR: pnpmPreflight.globalBinDir,
              npm_config_global_bin_dir: pnpmPreflight.globalBinDir,
              NPM_CONFIG_GLOBAL_BIN_DIR: pnpmPreflight.globalBinDir,
            }
          : {}),
      };
    }
    const stageNative = params.installTarget.manager !== "npm";
    let globalBinDir = pnpmPreflight.globalBinDir ?? undefined;
    if (stageNative && !globalBinDir) {
      const bin = await runPnpmPreflightProbe({
        ...params,
        env: effectiveInstallEnv,
        args: params.installTarget.manager === "bun" ? ["pm", "bin", "-g"] : ["bin", "-g"],
        name: `${params.installTarget.manager}-staging-preflight`,
      });
      if (bin.failedStep) {
        return await packageUpdateFailure(bin.failedStep);
      }
      globalBinDir = bin.result
        ? readPackageManagerProbeValue(bin.result.stdout) || undefined
        : undefined;
    }
    const nativeOptions = stageNative
      ? { env: effectiveInstallEnv ?? process.env, globalBinDir, installSpec: params.installSpec }
      : undefined;
    const preparedInstall = await prepareStagedPackageInstall(
      params.installTarget,
      params.packageName,
      nativeOptions,
    );
    if (preparedInstall.failedStep) {
      return await packageUpdateFailure(preparedInstall.failedStep);
    }
    stagedInstall = preparedInstall.stagedInstall;
    const commandEnv = stagedInstall.native?.env ?? effectiveInstallEnv;
    const installEnv = commandEnv === undefined ? {} : { env: commandEnv };

    if (params.installTarget.manager === "pnpm" && stagedInstall.native) {
      const stage = stagedInstall.native;
      for (const [probeName, expectedPath] of [
        ["root", stage.globalRoot],
        ["bin", stage.binDir],
      ] as const) {
        const args = [probeName, "-g", ...stage.configArgs];
        const probe = await runPnpmPreflightProbe({
          ...params,
          args,
          cwd: stage.projectRoot,
          env: stage.env,
          name: "pnpm-staging-preflight",
        });
        const reportedPath = probe.result && readPackageManagerProbeValue(probe.result.stdout);
        if (
          !reportedPath ||
          (await resolveCanonicalPath(reportedPath)) !== (await resolveCanonicalPath(expectedPath))
        ) {
          const failedStep = probe.failedStep ?? {
            name: "pnpm-staging-preflight",
            command: [params.installTarget.command, ...args].join(" "),
            cwd: stage.projectRoot,
            durationMs: 0,
            exitCode: 1,
            stderrTail: `pnpm ${probeName} selected ${reportedPath || "an unknown path"}, expected staged destination ${expectedPath}. The live installation was left unchanged.`,
          };
          return await packageUpdateFailure(failedStep, [...steps, failedStep]);
        }
      }
    }

    const installCommandTarget = stagedInstall.installTarget;
    const preparedSpec = await prepareNpmGitSourceInstallSpec({
      installTarget: installCommandTarget,
      installSpec: params.installSpec,
      packageName: params.packageName,
      runStep: params.runStep,
      timeoutMs: workTimeoutMs,
      env: params.env,
      installCwd: params.installCwd,
    });
    packedInstallDir = preparedSpec.packDir;
    steps.push(...preparedSpec.steps);
    if (preparedSpec.failedStep) {
      return await packageUpdateFailure(preparedSpec.failedStep, steps);
    }

    // Native managers select their project from cwd; resolve local specs against
    // the original caller before installing inside the private project.
    const updateCwd = stagedInstall.native?.projectRoot ?? preparedSpec.installCwd;
    const updateInstallSpec =
      installCommandTarget.manager !== "npm"
        ? resolveNativeInstallSpecFromCwd(
            preparedSpec.installSpec,
            params.packageName,
            preparedSpec.installCwd ?? process.cwd(),
            installCommandTarget.manager,
          )
        : preparedSpec.installSpec;
    const updateStep = await classifyPackageUpdatePermissionFailure(
      await params.runStep({
        name: "package-install",
        argv: [
          ...globalInstallArgs(
            installCommandTarget,
            updateInstallSpec,
            undefined,
            stagedInstall.prefix,
            preparedSpec.installCwd,
            npmPreflight.policy ?? undefined,
          ),
          ...(stagedInstall.native?.configArgs ?? []),
        ],
        ...(updateCwd ? { cwd: updateCwd } : {}),
        ...installEnv,
        timeoutMs: workTimeoutMs,
      }),
      params.installTarget,
      params.env,
    );

    steps.push(updateStep);
    let finalInstallStep = updateStep;
    if (updateStep.exitCode !== 0) {
      if (updateStep.failureFacts?.some((fact) => fact.code === UPDATE_GLOBAL_PERMISSION_REASON)) {
        return await packageUpdateFailure(updateStep, steps);
      }
      const cleanupFailure = await cleanupStage();
      if (cleanupFailure) {
        return await packageUpdateFailure(cleanupFailure, [...steps, cleanupFailure]);
      }
      if (installCommandTarget.manager !== "npm") {
        return await packageUpdateFailure(updateStep, steps);
      }
      const preparedFallbackInstall = await prepareStagedPackageInstall(
        params.installTarget,
        params.packageName,
      );
      if (preparedFallbackInstall.failedStep) {
        steps.push(preparedFallbackInstall.failedStep);
        return await packageUpdateFailure(preparedFallbackInstall.failedStep, steps);
      }
      stagedInstall = preparedFallbackInstall.stagedInstall;
      const fallbackArgv = globalInstallFallbackArgs(
        stagedInstall.installTarget,
        preparedSpec.installSpec,
        undefined,
        stagedInstall.prefix,
        preparedSpec.installCwd,
        npmPreflight.policy ?? undefined,
      );
      if (!fallbackArgv) {
        return await packageUpdateFailure(updateStep, steps);
      }
      const fallbackStep = await classifyPackageUpdatePermissionFailure(
        await params.runStep({
          name: "package-install-omit-optional",
          argv: fallbackArgv,
          ...(preparedSpec.installCwd ? { cwd: preparedSpec.installCwd } : {}),
          ...installEnv,
          timeoutMs: workTimeoutMs,
        }),
        params.installTarget,
        params.env,
      );
      steps.push(fallbackStep);
      finalInstallStep = fallbackStep;
    }

    if (isFailedUpdateStep(finalInstallStep)) {
      return await packageUpdateFailure(finalInstallStep, steps);
    }

    if (stagedInstall.native && params.installTarget.pnpmIsolated) {
      const activePackages = await listActivePnpmIsolatedGlobalPackages({
        globalRoot: stagedInstall.native.globalRoot,
        packageName: params.packageName,
      });
      const candidate = activePackages.length === 1 ? activePackages[0] : undefined;
      if (!candidate) {
        const failedStep: UpdateStepResult = {
          name: "package-verify",
          command: "resolve staged pnpm replacement",
          cwd: stagedInstall.native.projectRoot,
          durationMs: 0,
          exitCode: 1,
          stderrTail: "could not identify a unique active staged pnpm replacement package",
        };
        return await packageUpdateFailure(failedStep, [...steps, failedStep]);
      }
      stagedInstall.packageRoot = candidate.packageRoot;
    }

    const verificationPackageRoot = stagedInstall.packageRoot;
    await params.beforeVerifyCandidate?.(verificationPackageRoot);
    if (packageRoot && params.beforeVerifyCandidate) {
      // Admission staging owns only its private prefix. Retire old backups only
      // after the supervisor resumes admitted package preparation.
      await cleanupGlobalRenameDirs({
        globalRoot: path.dirname(packageRoot),
        packageName: params.packageName,
      });
    }
    const candidateVersion = await readPackageVersion(verificationPackageRoot);
    const expectedVersion = resolveExpectedInstalledVersionFromSpec(
      params.packageName,
      params.installSpec,
    );
    let verificationErrors = await collectInstalledGlobalPackageErrors({
      packageRoot: verificationPackageRoot,
      expectedVersion,
      expectedGitCheckout: params.expectedGitCheckout,
    });
    // Registry versions identify published releases. Explicit artifacts can
    // be rebuilt at the same version, so compare known build identities before
    // skipping validation. Missing identity is not equality.
    const registryTarget = isRegistrySourceInstallSpec(params.installSpec);
    let sameArtifact = false;
    if (!registryTarget && originalPackageRoot) {
      const [candidateBuild, installedBuild] = await Promise.all([
        readBuiltGatewayBuildId(verificationPackageRoot),
        readBuiltGatewayBuildId(originalPackageRoot),
      ]);
      sameArtifact = Boolean(candidateBuild && candidateBuild === installedBuild);
    }
    // Verify the requested candidate before admitting a no-op.
    // Source exposure follows the Git SHA contract instead.
    if (
      verificationErrors.length === 0 &&
      !params.expectedGitCheckout &&
      !params.requirePackageReplacement &&
      (registryTarget || sameArtifact) &&
      candidateVersion &&
      candidateVersion === (await readPackageVersionIfPresent(originalPackageRoot))
    ) {
      const cleanupFailure = await cleanupStage();
      if (cleanupFailure) {
        return await packageUpdateFailure(cleanupFailure, [...steps, cleanupFailure]);
      }
      return {
        reason: "already-current",
        steps,
        activePackageRoot: originalPackageRoot,
        afterVersion: candidateVersion,
        failedStep: null,
        recovery: await verifyPackageUpdateRecovery(originalPackageRoot),
      };
    }
    // v2026.8.1 alone shipped this pending marker inside the closed dist inventory.
    const blockingVerificationErrors = verificationErrors.filter(
      (error) =>
        params.installSpec !== "openclaw@2026.8.1" ||
        error !== `unexpected packaged dist file ${LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH}`,
    );
    if (blockingVerificationErrors.length === 0) {
      const lifecycle = await runPackageUpdateLifecycle({
        packageRoot: verificationPackageRoot,
        nodeRunner: params.resolveLifecycleNodeRunner?.(),
        manager: params.installTarget.manager,
        timeoutMs: params.timeoutMs,
        workTimeoutMs: params.workTimeoutMs,
        env: commandEnv,
        runStep: params.runStep,
        steps,
        verifyCompleted: async () => {
          verificationErrors = await collectInstalledGlobalPackageErrors({
            packageRoot: verificationPackageRoot,
            expectedVersion,
            expectedGitCheckout: params.expectedGitCheckout,
          });
        },
      });
      if (lifecycle.status === "failed") {
        if (lifecycle.preserveStage) {
          // Another writer may still use this exact candidate. Recovery verifies
          // the previous runtime while the finalizer preserves this stage.
          uncertainLifecycleStage = stagedInstall;
        }
        return await packageUpdateFailure(lifecycle.step, steps);
      }
    }
    if (!params.expectedGitCheckout && verificationErrors.length === 0) {
      verificationErrors.push(
        ...(await collectPackageDistContentInventoryErrors(verificationPackageRoot)),
      );
    }
    if (verificationErrors.length > 0) {
      steps.push(
        createPackageVerificationFailureStep(
          verificationPackageRoot,
          verificationErrors,
          params.env,
        ),
      );
    }
    let failedVerification = verificationErrors.length > 0;
    if (verificationErrors.length === 0) {
      const validation = (await params.validateCandidate?.(verificationPackageRoot)) ?? [];
      steps.push(...validation);
      const rejectedCandidate = validation.find(isFailedUpdateStep);
      if (rejectedCandidate) {
        return await packageUpdateFailure(rejectedCandidate, steps);
      }
      if (params.activateGitRoot) {
        if (
          stagedInstall.native ||
          !params.expectedGitCheckout ||
          !(await fs.lstat(stagedInstall.packageRoot)).isSymbolicLink()
        ) {
          throw new Error(
            "Prepared source checkout exposure requires an npm package symlink; the current installation has not been changed.",
          );
        }
        // The source owner publishes this exact root inside beforeActivate. Rebind only
        // after validating the temporary candidate, so its cleanup cannot break exposure.
        await fs.unlink(stagedInstall.packageRoot);
        await fs.symlink(
          path.resolve(params.activateGitRoot),
          stagedInstall.packageRoot,
          process.platform === "win32" ? "junction" : undefined,
        );
      }
      const swap = await swapStagedPackageInstall({
        timeoutMs: params.timeoutMs,
        stage: stagedInstall,
        installTarget: params.installTarget,
        packageName: params.packageName,
        postVerifyStep: params.postVerifyStep,
        beforeActivate: params.beforeActivate,
        assertCurrent: params.assertCurrent,
        onLiveMutation: () => {
          liveTreeMutated = true;
        },
        onTransaction: params.onTransaction,
        localOverrides: params.expectedGitCheckout ? undefined : params.localOverrides,
        onLocalOverrides: (result) => {
          localOverrides = result;
          if (result.status === "none") {
            return;
          }
          const message = `Local package overrides: ${result.status}; ${result.applied} replayed. Recovery bundle: ${result.recoveryDir}. ${result.warnings.join(" ")}`;
          const report: UpdateStepResult = {
            name: "local-package-overrides",
            command: "preserve packaged dist edits",
            cwd: originalPackageRoot ?? process.cwd(),
            durationMs: 0,
            exitCode: result.status === "error" ? 1 : 0,
            stdoutTail: message,
            // Existing warning rows keep recovery location visible after handoff/finalization.
            ...(result.status === "error"
              ? { stderrTail: message }
              : { advisory: { kind: "recoverable-maintenance", message } }),
          };
          const previous = steps.findIndex((step) => step.name === report.name);
          if (previous === -1) {
            steps.push(report);
          } else {
            steps[previous] = report;
          }
        },
      });
      steps.push(swap.step);
      if (swap.postVerifyStep) {
        steps.push(swap.postVerifyStep);
      }
      failedVerification = swap.status === "failed";
      activePackageRoot = swap.activePackageRoot;
      // Verified rollback restores package files, not state changed by hooks.
      if (swap.status === "committed") {
        committed = true;
        afterVersion = candidateVersion;
      } else {
        packageRollbackVerified = swap.packageRollbackVerified;
      }
    }

    if (failedVerification) {
      afterVersion = await readPackageVersionIfPresent(activePackageRoot);
    }

    const failedStep =
      steps.find((step) => step !== updateStep && isFailedUpdateStep(step)) ?? null;

    if (failedStep) {
      return await packageUpdateFailure(failedStep, steps);
    }
    const cleanupFailure = await cleanupStage();
    if (cleanupFailure) {
      return await packageUpdateFailure(cleanupFailure, [...steps, cleanupFailure]);
    }
    return {
      localOverrides,
      steps,
      activePackageRoot,
      afterVersion,
      failedStep,
      recovery: afterVersion
        ? { serviceRestartSafe: true, version: afterVersion }
        : { serviceRestartSafe: false, reason: "runtime-verification-failed" },
    };
  } catch (error) {
    cleanupUncertain = hasCommandProcessCleanupError(error);
    if (cleanupUncertain) {
      throw error;
    }
    if (error instanceof PackageUpdateActivationError) {
      throw error.cause;
    }
    if (error instanceof FreeBsdPkgOwnershipError) {
      throw error;
    }
    const failedStep = await classifyPackageUpdatePermissionFailure(
      {
        name: "package-update",
        command: "update installed package",
        cwd: activePackageRoot ?? params.installCwd ?? process.cwd(),

        durationMs: 0,
        exitCode: 1,
        stderrTail: formatErrorMessage(error),
      },
      params.installTarget,
      params.env,
      error,
    );
    return await packageUpdateFailure(failedStep, [...steps, failedStep]);
  } finally {
    if (!cleanupUncertain) {
      // Normal returns already disposed or retained their exact stage. Exceptional
      // activation/service causes still clean safely without replacing their cause.
      await cleanupStage();
      if (packedInstallDir) {
        await removePackageUpdatePath(packedInstallDir);
      }
    }
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
