import fs from "node:fs/promises";
import path from "node:path";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { ignoreMissingPath } from "./errno.js";
import { normalizeGitPathForFilesystem } from "./git-exec.js";
import { isFailedUpdateStep } from "./update-run-step.js";
import { reportUpdateStepCompletion, runStep } from "./update-runner-command.js";
import {
  buildDevTargetRefResolutionCandidates,
  createGitStepFactory,
  resolveTagFetchRef,
  type StepFactory,
} from "./update-runner-git-commands.js";
import type { RunStepOptions } from "./update-runner-types.js";
import type { UpdateStepResult } from "./update-step-result.js";

export function isInterruptedGitStep(step: UpdateStepResult): boolean {
  return (
    step.termination !== "timeout" &&
    step.termination !== "no-output-timeout" &&
    (step.termination === "signal" ||
      Boolean(step.signal) ||
      step.exitCode === 130 ||
      step.exitCode === 143)
  );
}

/** Git can time out during history inspection, before it has a rebase to abort. */
export async function abortGitPreflightRebase(
  options: RunStepOptions,
): Promise<UpdateStepResult | null> {
  const state = await runStep({
    ...options,
    name: "preflight-rebase-state",
    argv: ["git", "-C", options.cwd, "rev-parse", "--absolute-git-dir"],
  });
  const gitDir = state.stdoutTail?.trim();
  if (isFailedUpdateStep(state) || !gitDir) {
    return state;
  }
  const active = await Promise.all(
    ["rebase-merge", "rebase-apply"].map((name) =>
      fs.stat(path.join(normalizeGitPathForFilesystem(gitDir), name)).catch(ignoreMissingPath),
    ),
  );
  // Permission and other inspection errors propagate; only ENOENT certifies absence.
  if (!active.some(Boolean)) {
    return null;
  }
  const aborted = await runStep(options);
  return isFailedUpdateStep(aborted) ? aborted : null;
}

export async function resolveExplicitGitPreflightTarget(params: {
  devTargetRef: string;
  refreshedRemotes: readonly string[];
  gitRoot: string;
  step: StepFactory;
  workStep: StepFactory;
}): Promise<string | null> {
  const step = createGitStepFactory(params.gitRoot, params.step);
  const workStep = createGitStepFactory(params.gitRoot, params.workStep);
  const warnings: string[] = [];
  for (const candidate of buildDevTargetRefResolutionCandidates(params.devTargetRef)) {
    if (
      candidate.startsWith("refs/remotes/") &&
      !params.refreshedRemotes.some((remote) => candidate.startsWith(`refs/remotes/${remote}/`))
    ) {
      continue;
    }
    const tagFetchRef = resolveTagFetchRef(candidate);
    if (tagFetchRef) {
      const remoteStep = await runStep(step("git-remote", "remote"));
      if (isFailedUpdateStep(remoteStep)) {
        return null;
      }
      const remotes = normalizeStringEntries((remoteStep.stdoutTail ?? "").split("\n"));
      let fetchedTag = false;
      for (const remote of remotes) {
        const options = workStep(
          "git-fetch-target-tag",
          "fetch",
          remote,
          `+${tagFetchRef}:${tagFetchRef}`,
        );
        const fetchOutcome = await runClassifiedGitStep(options, (fetchStep) => {
          const interrupted =
            fetchStep.termination === "signal" ||
            fetchStep.exitCode === 130 ||
            fetchStep.exitCode === 143;
          const fetchedSuccessfully = fetchStep.exitCode === 0 && !isFailedUpdateStep(fetchStep);
          if (!fetchedSuccessfully && !interrupted) {
            fetchStep.advisory = {
              kind: "recoverable-maintenance",
              message: `Could not fetch the requested tag from ${remote}; trying another remote. ${fetchStep.stderrTail ?? ""}`,
            };
            warnings.push(fetchStep.advisory.message);
          }
          if (warnings.length > 0) {
            fetchStep.warnings = [...warnings];
          }
          return { interrupted, fetchedSuccessfully };
        });
        if (fetchOutcome.interrupted) {
          return null;
        }
        if (fetchOutcome.fetchedSuccessfully) {
          fetchedTag = true;
          break;
        }
      }
      if (remotes.length > 0 && !fetchedTag) {
        continue;
      }
    }
    const shaStep = await runStep(step("git-resolve-target", "rev-parse", candidate));
    const sha = shaStep.stdoutTail?.trim();
    if (!isFailedUpdateStep(shaStep) && sha) {
      return sha;
    }
  }
  return null;
}

/** Publish completion only after the Git owner classifies its result. */
export async function runClassifiedGitStep<T>(
  options: RunStepOptions,
  classify: (result: UpdateStepResult) => T,
): Promise<T> {
  const result = await runStep({
    ...options,
    progress: { ...options.progress, onStepComplete: undefined },
  });
  const classified = classify(result);
  await reportUpdateStepCompletion(options.progress, {
    ...result,
    index: options.stepIndex,
    total: options.totalSteps,
  });
  return classified;
}

/** Git config exits 1 without output for an unset key: a complete answer, not a failed read. */
export function runGitConfigReadStep(options: RunStepOptions) {
  return runClassifiedGitStep(options, (result) => {
    if (
      result.exitCode === 1 &&
      (!result.termination || result.termination === "exit") &&
      !result.killed &&
      !result.outputLimitExceeded &&
      !result.stdoutTail?.trim() &&
      !result.stderrTail?.trim()
    ) {
      result.exitCode = 0;
      delete result.failureFacts;
    }
    return result;
  });
}

// A successful Git status command does not imply a clean checkout.
export function runGitCleanCheckStep(options: RunStepOptions) {
  return runClassifiedGitStep(options, (result) => {
    const dirty = !isFailedUpdateStep(result) && Boolean(result.stdoutTail?.trim());
    if (dirty) {
      result.exitCode = 1;
      result.stderrTail = "This checkout has local changes. Installation has not started.";
    }
    return { result, dirty };
  });
}
