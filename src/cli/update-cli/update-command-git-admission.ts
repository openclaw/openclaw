import { createUpdatePreflightFailure } from "../../infra/update-preflight-details.js";
import { recordUpdateRunPhase } from "../../infra/update-run-ledger.js";
import { isFailedUpdateStep } from "../../infra/update-run-step.js";
import type { UpdateRunnerOptions, UpdateStepProgress } from "../../infra/update-runner-types.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { defaultRuntime } from "../../runtime.js";
import { UpdatePreMutationError, type UpdateCommandOptions } from "./shared.js";
import { prepareSourceUpdateRuntime } from "./update-command-runtime.js";

type BeforeGitMutation = NonNullable<UpdateRunnerOptions["beforeGitMutation"]>;

/** Artifact custody outlives both ordinary and initialized-profile executors. */
export async function withSourceUpdateArtifactLifetime(
  operation: (
    registerRun: (run: NonNullable<UpdateCommandOptions["run"]>) => void,
  ) => Promise<void>,
): Promise<void> {
  let run: UpdateCommandOptions["run"];
  try {
    await operation((admitted) => {
      run = admitted;
    });
  } catch (error) {
    if (hasCommandProcessCleanupError(error)) {
      run?.artifactOwnership?.retainUnjoined();
    }
    throw error;
  } finally {
    await run?.artifactOwnership?.release().catch((error: unknown) => {
      defaultRuntime.error(
        `Warning: could not release source artifact ownership: ${String(error)}`,
      );
    });
  }
}

export async function admitSourceUpdateArtifacts(params: {
  root: string;
  timeoutMs: number;
  nodeRunner?: string;
  assertCurrent(): void;
  run: UpdateCommandOptions["run"];
  progress: UpdateStepProgress;
}) {
  const step = {
    name: "source-artifact-ownership",
    command: "admit installed checkout runtime artifacts",
    cwd: params.root,
    index: 0,
    total: 0,
  };
  const startedAt = Date.now();
  params.progress.onStepStart?.(step);
  try {
    const ownership = await prepareSourceUpdateRuntime(params);
    if (ownership) {
      if (!params.run) {
        await ownership.release();
        throw new Error("Source artifact admission requires the original update run.");
      }
      params.run.artifactOwnership = ownership;
    }
    params.progress.onStepComplete?.({ ...step, durationMs: Date.now() - startedAt, exitCode: 0 });
  } catch (error) {
    const detail = String(error);
    params.progress.onStepComplete?.({
      ...step,
      durationMs: Date.now() - startedAt,
      exitCode: 1,
      stderrTail: detail,
    });
    throw new UpdatePreMutationError(step.name, detail, { cause: error });
  }
}

export function recordInspectedGitTarget(
  run: UpdateCommandOptions["run"],
  target: Parameters<BeforeGitMutation>[0],
  assertCurrent: () => void,
): void {
  assertCurrent();
  if (run) {
    recordUpdateRunPhase(
      run.runId,
      "staging",
      {
        target: { kind: "git", sha: target.sha, version: target.version },
      },
      { env: run.env },
    );
  }
  assertReadableGitTarget(target);
}

export function assertReadableGitTarget(target: Parameters<BeforeGitMutation>[0]): void {
  if (target.metadataUnreadable) {
    const failure = createUpdatePreflightFailure("target-git-metadata", target.metadataUnreadable);
    throw new UpdatePreMutationError("target-metadata-preflight", failure.message, {
      failureFacts: failure.failureFacts,
    });
  }
}

export function assertValidatedGitCandidate(steps: readonly UpdateStepResult[]): void {
  const failed = steps.find(isFailedUpdateStep);
  if (failed) {
    throw new UpdatePreMutationError(failed.name, failed.stderrTail ?? "Update checks failed.", {
      failureFacts: failed.failureFacts,
    });
  }
}
