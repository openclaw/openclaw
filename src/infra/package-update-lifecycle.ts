import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatErrorMessage } from "./errors.js";
import { resolveInstallWorkTimeoutMs } from "./install-mode-options.js";
import {
  completePendingPackageLifecycle,
  PackageLifecycleOwnershipError,
  type PackageLifecycleScript,
} from "./package-lifecycle.js";
import { classifyPackageUpdatePermissionFailure } from "./package-update-manager-preflight.js";
import type { StagedPackageInstall } from "./package-update-swap-contract.js";
import { mergePathPrepend } from "./path-prepend.js";
import { resolveEnvironmentValue } from "./process-env.js";
import { resolveExternalPackageRuntimeEntrypointUrl } from "./runtime-process-url.js";
import { verifyPackageUpdateRecovery, type ResolvedGlobalInstallTarget } from "./update-global.js";
import { recordManagedUpdatePackageStage } from "./update-handoff-recovery.js";
import { prepareNativePackageStage } from "./update-native-package-stage.js";
import {
  resolveNpmGlobalPrefixLayoutFromGlobalRoot,
  resolveNpmGlobalPrefixLayoutFromPrefix,
} from "./update-npm-prefix.js";
import type { UpdateRecovery } from "./update-recovery.js";
import { isFailedUpdateStep } from "./update-run-step.js";
import type { UpdateStepResult } from "./update-step-result.js";

export type PackageUpdateStepRunner = (params: {
  name: string;
  argv: string[];
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  input?: string;
}) => Promise<UpdateStepResult>;

type PackageUpdateLifecycleResult =
  | { status: "complete" }
  | { status: "failed"; step: UpdateStepResult; preserveStage: boolean };

/** Adapt lifecycle ownership refusal without flattening it into removable stage failure. */
export async function runPackageUpdateLifecycle(params: {
  packageRoot: string;
  nodeRunner?: string;
  manager: ResolvedGlobalInstallTarget["manager"];
  timeoutMs: number;
  /** Null leaves script work unbounded; omission retains the caller's timeout. */
  workTimeoutMs?: number | null;
  env?: NodeJS.ProcessEnv;
  runStep: PackageUpdateStepRunner;
  verifyCompleted: () => Promise<void>;
  steps: UpdateStepResult[];
}): Promise<PackageUpdateLifecycleResult> {
  const env =
    params.nodeRunner && path.isAbsolute(params.nodeRunner)
      ? {
          ...params.env,
          PATH: mergePathPrepend(resolveEnvironmentValue(params.env ?? process.env, "PATH"), [
            path.dirname(params.nodeRunner),
          ]),
        }
      : params.env;
  let failedScript: UpdateStepResult | null = null;
  try {
    await completePendingPackageLifecycle({
      packageRoot: params.packageRoot,
      timeoutMs: params.timeoutMs,
      runScript: async (script: PackageLifecycleScript) => {
        const step = await params.runStep({
          name: `${params.manager}-package-${script.name}`,
          argv: [
            params.nodeRunner ?? process.execPath,
            fileURLToPath(
              resolveExternalPackageRuntimeEntrypointUrl(script.name, params.packageRoot),
            ),
          ],
          cwd: params.packageRoot,
          env,
          timeoutMs: resolveInstallWorkTimeoutMs(params.workTimeoutMs, params.timeoutMs),
        });
        params.steps.push(step);
        if (isFailedUpdateStep(step)) {
          failedScript = step;
          throw new Error(step.stderrTail ?? `${step.name} failed`);
        }
      },
    });
    // Another owner may have completed the work after the caller first verified it.
    await params.verifyCompleted();
    return { status: "complete" };
  } catch (error) {
    const preserveStage =
      error instanceof PackageLifecycleOwnershipError &&
      error.packageRoot === path.resolve(params.packageRoot);
    if (failedScript && !preserveStage) {
      return { status: "failed", step: failedScript, preserveStage: false };
    }
    const step: UpdateStepResult = {
      name: `${params.manager}-package-lifecycle`,
      command: `complete ${params.packageRoot}`,
      cwd: params.packageRoot,
      durationMs: 0,
      exitCode: 1,
      stderrTail: formatErrorMessage(error),
    };
    params.steps.push(step);
    return { status: "failed", step, preserveStage };
  }
}

export async function prepareStagedPackageInstall(
  installTarget: ResolvedGlobalInstallTarget,
  packageName: string,
  nativeOptions?: { env: NodeJS.ProcessEnv; globalBinDir?: string; installSpec: string },
  env?: NodeJS.ProcessEnv,
): Promise<
  | { stagedInstall: StagedPackageInstall; failedStep: null }
  | { stagedInstall: null; failedStep: UpdateStepResult }
> {
  const startedAt = Date.now();
  try {
    let native: StagedPackageInstall["native"];
    let prefix: string;
    let layout: StagedPackageInstall["layout"];
    if (nativeOptions) {
      const prepared = await prepareNativePackageStage({
        installTarget,
        packageName,
        ...nativeOptions,
      });
      if (!prepared) {
        throw new Error("Cannot resolve the native package manager's staging owner.");
      }
      native = prepared;
      prefix = native.projectRoot;
      layout = { prefix, globalRoot: native.globalRoot, binDir: native.binDir };
    } else {
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
      prefix = await fs.mkdtemp(path.join(targetLayout.globalRoot, ".openclaw.update-stage-"));
      layout = resolveNpmGlobalPrefixLayoutFromPrefix(prefix);
    }
    // Isolated pnpm resolves its newly created owner after installation.
    const packageRoot = path.join(layout.globalRoot, packageName);
    if (!native) {
      await recordManagedUpdatePackageStage({ prefix, packageRoot }, env).catch(
        (error: unknown) => {
          console.warn(
            `[update] Package stage cleanup custody could not be recorded: ${formatErrorMessage(error)}. The update will continue; inspect retained stages if it is interrupted.`,
          );
        },
      );
    }
    return {
      stagedInstall: {
        prefix,
        layout,
        packageRoot,
        installTarget: {
          ...(native ? installTarget : { manager: "npm" as const, command: installTarget.command }),
          globalRoot: layout.globalRoot,
          packageRoot,
        },
        ...(native ? { native } : {}),
      },
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

/** A retained or discarded stage cannot establish the prior runtime's safety. */
export async function verifyUnchangedPackageUpdateRecovery(
  packageRoot: string | null,
  initialRecovery: UpdateRecovery,
): Promise<UpdateRecovery> {
  if (!initialRecovery.serviceRestartSafe) {
    return initialRecovery;
  }
  const recovery = await verifyPackageUpdateRecovery(packageRoot);
  return recovery.serviceRestartSafe && recovery.version === initialRecovery.version
    ? recovery
    : { serviceRestartSafe: false, reason: "runtime-verification-failed" };
}
