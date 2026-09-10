import { quoteCliArg, quotePowerShellArg } from "../cli/quote-cli-arg.js";
import { markPackagePostInstallDoctorAdvisory } from "./package-update-steps.js";
import {
  consumeUpdatePostInstallDoctorResult,
  createUpdatePostInstallDoctorResultPath,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
} from "./update-doctor-result.js";
import { runStep } from "./update-runner-command.js";
import type { RunStepOptions } from "./update-runner-types.js";

// Publish completion only after the owner classifies its recoverable result.
export async function runGitUpstreamStep(options: RunStepOptions) {
  const upstreamStep = await runStep({
    ...options,
    progress: { ...options.progress, onStepComplete: undefined },
  });
  if (
    typeof upstreamStep.exitCode === "number" &&
    upstreamStep.exitCode !== 0 &&
    !upstreamStep.signal &&
    !upstreamStep.killed &&
    (!upstreamStep.termination || upstreamStep.termination === "exit") &&
    upstreamStep.exitCode !== 130 &&
    upstreamStep.exitCode !== 143
  ) {
    const quote = process.platform === "win32" ? quotePowerShellArg : quoteCliArg;
    upstreamStep.advisory = {
      kind: "recoverable-maintenance",
      message: `Skipped Git upstream tracking setup. Complete it with: git ${options.argv.slice(1).map(quote).join(" ")}. Reason: ${upstreamStep.stderrTail || "git branch failed"}`,
    };
  }
  options.progress?.onStepComplete?.({
    ...upstreamStep,
    index: options.stepIndex,
    total: options.totalSteps,
  });
  return upstreamStep;
}

export async function runGitDoctorStep(params: {
  root: string;
  entryPath: string;
  nodePath: string;
  fix: boolean;
  env: NodeJS.ProcessEnv;
  step: (name: string, argv: string[], cwd: string, env?: NodeJS.ProcessEnv) => RunStepOptions;
}) {
  const options = params.step(
    "openclaw doctor",
    [
      params.nodePath,
      params.entryPath,
      "doctor",
      "--non-interactive",
      ...(params.fix ? ["--fix"] : []),
    ],
    params.root,
    params.env,
  );
  const doctorResultPath = createUpdatePostInstallDoctorResultPath();
  try {
    const doctorStep = await runStep({
      ...options,
      env: { ...options.env, [UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]: doctorResultPath },
      progress: { ...options.progress, onStepComplete: undefined },
    });
    Object.assign(
      doctorStep,
      markPackagePostInstallDoctorAdvisory(
        doctorStep,
        await consumeUpdatePostInstallDoctorResult(doctorResultPath),
      ),
    );
    options.progress?.onStepComplete?.({
      ...doctorStep,
      index: options.stepIndex,
      total: options.totalSteps,
    });
    return doctorStep;
  } catch (error) {
    await consumeUpdatePostInstallDoctorResult(doctorResultPath);
    throw error;
  }
}
