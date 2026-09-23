import { UpdateRequesterRevokedError } from "../../infra/update-requester-authority.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import type { UpdateCommandOptions } from "./shared.js";
import { UpdateActivationTimeoutError } from "./update-command-activation.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";

/** Bind requester and executor identity across discovery and delegated child admission. */
export function createUpdateCommandAuthority(
  params: {
    opts?: Pick<UpdateCommandOptions, "run">;
    executorFence?: UpdateRecoveryFence;
    assertCurrent?: () => void;
    onAuthorityRefused?: () => void;
  },
  label = "Update",
) {
  const run = params.opts?.run;
  const runExecutorFence = run?.executorFence;
  const executorFence = runExecutorFence ?? params.executorFence;
  const runId = run?.runId;
  const requester = run?.requesterAuthority;
  let authorityFailure: { error: unknown } | undefined;
  const refuseAuthority = (error: unknown): never => {
    if (error instanceof UpdateActivationTimeoutError && !authorityFailure) {
      throw run?.freebsdWriteAdmission?.failure ?? error;
    }
    authorityFailure ??= { error: run?.freebsdWriteAdmission?.revoke(error) ?? error };
    params.onAuthorityRefused?.();
    throw authorityFailure.error;
  };
  const checkAuthority = (check: () => void) => {
    if (authorityFailure) {
      throw authorityFailure.error;
    }
    try {
      run?.freebsdWriteAdmission?.assertCurrent();
      check();
    } catch (error) {
      refuseAuthority(error);
    }
  };
  const assertRequesterCurrent = () =>
    checkAuthority(() => {
      if (
        params.opts?.run !== run ||
        run?.executorFence !== runExecutorFence ||
        run?.runId !== runId ||
        run?.requesterAuthority !== requester ||
        (run && (!runExecutorFence || !runId?.trim()))
      ) {
        throw new UpdateCommandRecoveryPendingError(`${label} lost its original update executor.`);
      }
      if (requester?.isCurrent() === false) {
        throw new UpdateRequesterRevokedError();
      }
    });
  const assertCurrent = () =>
    checkAuthority(() => {
      assertRequesterCurrent();
      params.assertCurrent?.();
      executorFence?.assertCurrent();
    });
  return {
    run,
    executorFence,
    runId,
    requester,
    assertCurrent,
    assertRequesterCurrent,
    refuseAuthority,
  };
}
