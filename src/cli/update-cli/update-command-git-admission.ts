import { createUpdatePreflightFailure } from "../../infra/update-preflight-details.js";
import { recordUpdateRunPhase } from "../../infra/update-run-ledger.js";
import type { UpdateRunnerOptions } from "../../infra/update-runner-types.js";
import { UpdatePreMutationError, type UpdateCommandOptions } from "./shared.js";

type BeforeGitMutation = NonNullable<UpdateRunnerOptions["beforeGitMutation"]>;

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
