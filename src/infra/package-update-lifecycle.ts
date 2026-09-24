import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage, hasErrnoCode } from "./errors.js";
import { isPathInside } from "./fs-safe.js";
import {
  completePendingPackageLifecycle,
  discardPendingPackageLifecycle,
  PackageLifecycleOwnershipError,
} from "./package-lifecycle.js";
import { removePackageUpdatePath } from "./package-update-filesystem.js";
import type { StagedPackageInstall } from "./package-update-swap-contract.js";
import { mergePathPrepend } from "./path-prepend.js";
import { resolveEnvironmentValue } from "./process-env.js";
import {
  resolveNpmLifecyclePolicyGate,
  verifyPackageUpdateRecovery,
  type ResolvedGlobalInstallTarget,
} from "./update-global.js";
import type { UpdateRecovery } from "./update-recovery.js";
import { isFailedUpdateStep } from "./update-run-step.js";
import type { UpdateStepResult } from "./update-step-result.js";

export async function resolveNpmUpdateLifecyclePolicy(params: {
  installTarget: ResolvedGlobalInstallTarget;
}): Promise<{
  policy: ReturnType<typeof resolveNpmLifecyclePolicyGate>["policy"];
  failedStep: UpdateStepResult | null;
}> {
  const gate = resolveNpmLifecyclePolicyGate(params.installTarget);
  if (!gate.error) {
    return { policy: gate.policy, failedStep: null };
  }
  const argv = [params.installTarget.command, "--version"];
  const version = params.installTarget.npmOwner?.version ?? "";
  return {
    policy: null,
    failedStep: {
      name: "npm-lifecycle-policy-preflight",
      command: argv.join(" "),
      cwd: process.cwd(),
      durationMs: 0,
      exitCode: 1,
      stdoutTail: version || null,
      stderrTail: gate.error,
    },
  };
}

export type PackageUpdateStepRunner = (params: {
  name: string;
  argv: string[];
  cwd?: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
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
      runScript: async (script) => {
        const step = await params.runStep({
          name: `${params.manager}-package-${script.name}`,
          argv: [
            params.nodeRunner ?? process.execPath,
            path.join(params.packageRoot, script.relativePath),
          ],
          cwd: params.packageRoot,
          env,
          timeoutMs: params.timeoutMs,
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

class PackageStageRemovalError extends Error {}

async function cleanupStagedPackageInstall(stage: StagedPackageInstall): Promise<void> {
  const discard = async () => {
    if (!(await removePackageUpdatePath(stage.prefix))) {
      throw new PackageStageRemovalError(
        `Unable to remove discarded package stage ${stage.prefix}`,
      );
    }
    if (stage.native) {
      await removePackageUpdatePath(stage.native.binDir);
    }
  };
  const prefix = await fs.realpath(stage.prefix).catch((error: unknown) => {
    if (hasErrnoCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  });
  const candidates = [stage.packageRoot];
  if (prefix && stage.native && stage.installTarget.pnpmIsolated) {
    // Activation follows active hash links only. Disposal also removes unlinked
    // install directories left by a failed pnpm 11+ invocation, without requiring
    // a completed manifest or lockfile. Discovery errors must preserve the stage.
    const entries = await fs
      .readdir(stage.native.globalRoot, { withFileTypes: true })
      .catch((error: unknown) => {
        if (hasErrnoCode(error, "ENOENT")) {
          return [];
        }
        throw error;
      });
    for (const entry of entries) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        candidates.push(
          path.join(
            stage.native.globalRoot,
            entry.name,
            "node_modules",
            path.basename(stage.packageRoot),
          ),
        );
      }
    }
  }
  const packageRoots = new Set<string>();
  if (prefix) {
    for (const candidate of candidates) {
      const packageRoot = await fs.realpath(candidate).catch((error: unknown) => {
        if (hasErrnoCode(error, "ENOENT") || hasErrnoCode(error, "ENOTDIR")) {
          return null;
        }
        throw error;
      });
      if (
        packageRoot &&
        isPathInside(prefix, packageRoot) &&
        (await fs.stat(packageRoot)).isDirectory()
      ) {
        packageRoots.add(packageRoot);
      }
    }
  }
  // Missing/activated roots need no admission. Removing an external source link
  // does not remove its payload or authorize changing its lifecycle markers.
  await discardPendingPackageLifecycle({ packageRoots: [...packageRoots], discard });
}

/** Dispose only after pending work is retired under its lifecycle generation. */
export async function discardPackageUpdateStage(params: {
  stage: StagedPackageInstall;
  manager: ResolvedGlobalInstallTarget["manager"];
  committed: boolean;
}): Promise<PackageUpdateLifecycleResult | { status: "advisory"; step: UpdateStepResult }> {
  try {
    await cleanupStagedPackageInstall(params.stage);
    return { status: "complete" };
  } catch (error) {
    // Only a refused disposable-prefix removal after a verified swap is harmless.
    // Discovery, lifecycle ownership and release failures remain strict.
    if (params.committed && error instanceof PackageStageRemovalError) {
      const message = `${error.message}. Installation verification succeeded; inspect the retained stage before removing it manually.`;
      return {
        status: "advisory",
        step: {
          name: "package-stage-cleanup",
          command: `discard ${params.stage.prefix}`,
          cwd: params.stage.prefix,
          durationMs: 0,
          exitCode: 1,
          stderrTail: message,
          advisory: { kind: "recoverable-maintenance", message },
        },
      };
    }
    return {
      status: "failed",
      preserveStage: true,
      step: {
        name: `${params.manager}-package-lifecycle`,
        command: `discard ${params.stage.packageRoot}`,
        cwd: params.stage.packageRoot,
        durationMs: 0,
        exitCode: 1,
        stderrTail: formatErrorMessage(error),
      },
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
