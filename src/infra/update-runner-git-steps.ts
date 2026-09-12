import fs from "node:fs/promises";
import path from "node:path";
import { quoteCliArg, quotePowerShellArg } from "../cli/quote-cli-arg.js";
import { markPackagePostInstallDoctorAdvisory } from "./package-update-steps.js";
import { formatUpdateDoctorConfigWriteRefusal } from "./update-doctor-config.js";
import {
  consumeUpdatePostInstallDoctorResult,
  createUpdatePostInstallDoctorResultPath,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
} from "./update-doctor-result.js";
import { runStep } from "./update-runner-command.js";
import type {
  RunStepOptions,
  UpdateRunnerOptions,
  UpdateStepResult,
} from "./update-runner-types.js";

// Git status succeeding means the checkout was inspected, not that it is clean.
export async function runGitCleanCheckStep(options: RunStepOptions) {
  const result = await runStep({
    ...options,
    progress: { ...options.progress, onStepComplete: undefined },
  });
  const dirty = result.exitCode === 0 && Boolean(result.stdoutTail?.trim());
  if (dirty) {
    result.exitCode = 1;
    result.stderrTail = "This checkout has local changes. Installation has not started.";
  }
  options.progress?.onStepComplete?.({
    ...result,
    index: options.stepIndex,
    total: options.totalSteps,
  });
  return { result, dirty };
}

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

export async function resolveGitDoctorEntry(root: string, steps: UpdateStepResult[]) {
  const entry = path.join(root, "openclaw.mjs");
  if (
    await fs.stat(entry).then(
      () => true,
      () => false,
    )
  ) {
    return entry;
  }
  steps.push({
    name: "openclaw doctor entry",
    command: `verify ${entry}`,
    cwd: root,
    durationMs: 0,
    exitCode: 1,
    stderrTail: `missing ${entry}`,
  });
  return null;
}

export async function runGitDoctorStep(params: {
  root: string;
  runDoctor?: UpdateRunnerOptions["runGitDoctor"];
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
  if (params.runDoctor) {
    const result = await params.runDoctor(params.root);
    options.results?.push(
      result ?? {
        name: "openclaw doctor",
        command: "run activation doctor",
        cwd: params.root,
        durationMs: 0,
        exitCode: 1,
        stderrTail: "Required activation Doctor did not produce a result.",
      },
    );
    return result;
  }
  const doctorResultPath = createUpdatePostInstallDoctorResultPath();
  try {
    const doctorStep = await runStep({
      ...options,
      env: { ...options.env, [UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]: doctorResultPath },
      progress: { ...options.progress, onStepComplete: undefined },
    });
    const doctorResult = await consumeUpdatePostInstallDoctorResult(doctorResultPath);
    const configWriteRefusal = doctorResult?.configWriteRefusal;
    Object.assign(
      doctorStep,
      markPackagePostInstallDoctorAdvisory(
        {
          ...doctorStep,
          ...(doctorResult?.configChanges?.length
            ? { configChanges: doctorResult.configChanges }
            : {}),
          ...(configWriteRefusal
            ? {
                configWriteRefusal,
                exitCode: 1,
                stderrTail: formatUpdateDoctorConfigWriteRefusal(configWriteRefusal),
              }
            : {}),
        },
        doctorResult,
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
