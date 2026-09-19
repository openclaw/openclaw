import { createUpdatePreflightFailure } from "../../infra/update-preflight-details.js";
import { recordUpdateRunPhase } from "../../infra/update-run-ledger.js";
import type { UpdateRunnerOptions } from "../../infra/update-runner-types.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import { UpdatePreMutationError, type UpdateCommandOptions } from "./shared.js";
import type { PreManagedServiceStop } from "./update-command-service.js";

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
  if (target.metadataUnreadable) {
    const failure = createUpdatePreflightFailure("target-git-metadata", target.metadataUnreadable);
    throw new UpdatePreMutationError("target-metadata-preflight", failure.message, {
      failureFacts: failure.failureFacts,
    });
  }
}

export function createBeforeGitMutation(params: {
  updateRun?: UpdateCommandOptions["run"];
  roots: readonly string[];
  stopManagedService: (roots: readonly string[]) => Promise<void>;
  getPreManagedServiceStop: () => PreManagedServiceStop | undefined;
  checkTargetSchemas: (versions: OpenClawSchemaVersions | undefined) => Promise<void>;
  prepareMutableUpdate: () => Promise<void>;
}): BeforeGitMutation {
  return async (target) => {
    if (target?.metadataUnreadable) {
      const failure = createUpdatePreflightFailure(
        "target-git-metadata",
        target.metadataUnreadable,
      );
      throw new UpdatePreMutationError("target-metadata-preflight", failure.message, {
        failureFacts: failure.failureFacts,
      });
    }
    await params.checkTargetSchemas(target.schemaVersions);
    await params.prepareMutableUpdate();
    await params.stopManagedService(params.roots);
    const preManagedServiceStop = params.getPreManagedServiceStop();
    await params.checkTargetSchemas(target.schemaVersions);
    // Git's deferred prepare phase owns the task suspension. Once mutation
    // starts, only a verified recovery may re-enable persistent autostart.
    preManagedServiceStop?.windowsTaskAutoStartRecovery?.beginMutation();
    if (params.updateRun) {
      recordUpdateRunPhase(params.updateRun.runId, "activating", undefined, {
        env: params.updateRun.env,
      });
    }
    // Finalization owns the backed-up service rewrite and activation after Doctor.
    return { allowGatewayServiceRepair: false, allowGatewayActivation: false };
  };
}
