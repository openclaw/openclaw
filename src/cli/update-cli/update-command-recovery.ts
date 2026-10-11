import { formatErrorMessage } from "../../infra/errors.js";
import { verifyPackageUpdateRecovery } from "../../infra/update-global.js";
import { assertUpdateRecoveryAdmission } from "../../infra/update-run-recovery-admission.js";
import {
  loadUpdateRecovery,
  UpdateRecoveryRequiredError,
} from "../../infra/update-run-recovery.js";
import { readCurrentGitUpdateRecovery } from "../../infra/update-runner-git-recovery.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { UpdateCommandOptions } from "./shared.js";
import type { MutableUpdateExecutionParams } from "./update-command-execution.types.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import { UpdateCommandPendingRecoveryFailure } from "./update-command-result.js";

export function readOriginalUpdateRecovery(
  params: Pick<MutableUpdateExecutionParams, "installKind" | "root">,
  timeoutMs: number,
) {
  return params.installKind === "git"
    ? readCurrentGitUpdateRecovery(params.root, timeoutMs)
    : verifyPackageUpdateRecovery(params.root);
}

/** Refuse retained recovery before any package-only effects or diagnostic writes. */
export function assertUpdateCommandRecovery(opts: UpdateCommandOptions): void {
  opts.run?.executorFence?.assertCurrent();
  assertUpdateCommandRecoveryState(opts);
}

export function assertUpdateCommandRecoveryState(opts: UpdateCommandOptions): void {
  if (opts.recovery) {
    throw new UpdateCommandRecoveryPendingError(
      "Full-state checkpoint recovery is deferred; retained state was left unchanged.",
    );
  }
  const current = opts.run && loadUpdateRecovery(opts.run.runId, { env: opts.run.env });
  if (current) {
    throw new UpdateRecoveryRequiredError(current);
  }
}

/** Package-only finalization cannot adopt a retained full-state claim. */
export async function assertUpdateCommandPackageFinalization(
  params: Pick<FinishUpdateParams, "opts" | "result" | "ownedManagedUpdateEnv">,
): Promise<void> {
  const run = params.opts.run;
  const executor = run?.executorFence;
  const assertCurrent = () => executor?.assertCurrent();
  try {
    assertCurrent();
    if (params.opts.recovery) {
      throw new Error(
        "Full-state checkpoint recovery is deferred; retained state was left unchanged.",
      );
    }
    const env = params.ownedManagedUpdateEnv ?? params.opts.run?.env;
    // Keep the first target stable if selectors change during admission.
    const targetPath = resolveOpenClawStateSqlitePath(env);
    await assertUpdateRecoveryAdmission({ env, path: targetPath });
    assertCurrent();
    if (run && resolveOpenClawStateSqlitePath(run.env) !== targetPath) {
      await assertUpdateRecoveryAdmission({ env: run.env });
      assertCurrent();
    }
  } catch (cause) {
    throw new UpdateCommandPendingRecoveryFailure(params.result, formatErrorMessage(cause), {
      cause,
    });
  }
}

/** Hold the originally admitted executor through package finalization awaits. */
export function createUpdateCommandFinalizationFence(
  params: Pick<FinishUpdateParams, "opts" | "result">,
): () => void {
  const originalRun = params.opts.run;
  const executor = originalRun?.executorFence;
  return () => {
    try {
      executor?.assertCurrent();
    } catch (cause) {
      throw new UpdateCommandPendingRecoveryFailure(params.result, formatErrorMessage(cause), {
        cause,
      });
    }
  };
}
