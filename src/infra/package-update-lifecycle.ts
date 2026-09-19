import path from "node:path";
import { formatErrorMessage } from "./errors.js";
import {
  completePendingPackageLifecycle,
  PackageLifecycleOwnershipError,
} from "./package-lifecycle.js";
import type { UpdateStepResult } from "./update-runner-types.js";

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
  manager: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  runStep: PackageUpdateStepRunner;
  verifyCompleted: () => Promise<void>;
  steps: UpdateStepResult[];
}): Promise<PackageUpdateLifecycleResult> {
  let failedScript: UpdateStepResult | null = null;
  try {
    await completePendingPackageLifecycle({
      packageRoot: params.packageRoot,
      timeoutMs: params.timeoutMs,
      runScript: async (script) => {
        const step = await params.runStep({
          name: `${params.manager} package ${script.name}`,
          argv: [process.execPath, path.join(params.packageRoot, script.relativePath)],
          cwd: params.packageRoot,
          env: params.env,
          timeoutMs: params.timeoutMs,
        });
        params.steps.push(step);
        if (step.exitCode !== 0) {
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
      name: `${params.manager} package lifecycle`,
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
