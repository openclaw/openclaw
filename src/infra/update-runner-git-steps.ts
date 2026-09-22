import fs from "node:fs/promises";
import path from "node:path";
import { quoteCliArg, quotePowerShellArg } from "../cli/quote-cli-arg.js";
import { runStep } from "./update-runner-command.js";
import type { RunStepOptions, UpdateStepResult } from "./update-runner-types.js";

// A successful Git status command does not imply a clean checkout.
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
    name: "package-doctor-entry",
    command: `verify ${entry}`,
    cwd: root,
    durationMs: 0,
    exitCode: 1,
    stderrTail: `missing ${entry}`,
  });
  return null;
}
