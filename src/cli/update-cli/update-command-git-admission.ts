import { inspectSourceUpdateArtifacts } from "../../../scripts/lib/source-update-artifact-preflight.mts";
import { formatErrorMessage } from "../../infra/errors.js";
import { createUpdatePreflightFailure } from "../../infra/update-preflight-details.js";
import type { UpdateRunnerOptions } from "../../infra/update-runner-types.js";
import { UpdatePreMutationError, type UpdateCommandOptions } from "./shared.js";
import type { createUpdateCommandExecutionGuards } from "./update-command-execution-guards.js";

type BeforeGitMutation = NonNullable<UpdateRunnerOptions["beforeGitMutation"]>;

export async function admitSourceUpdateArtifacts(
  root: string,
  run: UpdateCommandOptions["run"],
): Promise<boolean> {
  try {
    const prepared = await inspectSourceUpdateArtifacts(root);
    if (prepared.lock && !run) {
      await prepared.lock.release();
      throw new Error("Source artifact admission requires an active update run.");
    }
    if (run) {
      run.sourceArtifactLock = prepared.lock;
    }
    return prepared.sourceRuntimePrepared;
  } catch (cause) {
    throw new UpdatePreMutationError("source-artifact-ownership", formatErrorMessage(cause), {
      cause,
    });
  }
}

export async function recordInspectedGitTarget(
  target: Parameters<BeforeGitMutation>[0],
  recordPhase: ReturnType<typeof createUpdateCommandExecutionGuards>["recordPhase"],
  assertCurrent: () => void,
): Promise<void> {
  assertCurrent();
  await recordPhase("staging", {
    target: { kind: "git", sha: target.sha, version: target.version },
  });
  assertCurrent();
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
