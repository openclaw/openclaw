import { UpdateRequesterRevokedError } from "../../infra/update-requester-authority.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import type { UpdateCommandOptions } from "./shared.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";

/** Bind requester and executor identity across discovery and delegated child admission. */
export function createUpdateCommandAuthority(
  params: {
    opts?: Pick<UpdateCommandOptions, "run">;
    executorFence?: UpdateRecoveryFence;
    assertCurrent?: () => void;
    onAuthorityRefused?: () => void;
    checkRequesterOnce?: true;
  },
  label = "Update",
) {
  const run = params.opts?.run;
  const executorFence = run?.executorFence ?? params.executorFence;
  const runId = run?.runId;
  const requester = run?.requesterAuthority;
  let requesterAdmitted = false;
  let authorityFailure: { error: unknown } | undefined;
  const refuseAuthority = (error: unknown): never => {
    authorityFailure ??= { error };
    params.onAuthorityRefused?.();
    throw authorityFailure.error;
  };
  const checkAuthority = (check: () => void) => {
    if (authorityFailure) {
      throw authorityFailure.error;
    }
    try {
      check();
    } catch (error) {
      refuseAuthority(error);
    }
  };
  const assertRequesterCurrent = () =>
    checkAuthority(() => {
      if (run && (!executorFence || !runId?.trim())) {
        throw new UpdateCommandRecoveryPendingError(`${label} lost its original update executor.`);
      }
      if (requester?.isCurrent() === false) {
        throw new UpdateRequesterRevokedError();
      }
      requesterAdmitted = true;
    });
  const assertCurrent = () =>
    checkAuthority(() => {
      // The admitted operation can run to completion. Keep executor and local
      // ownership checks live, including inside recursive package cleanup.
      // A new child admission can still explicitly check fresh requester policy.
      if (!params.checkRequesterOnce || !requesterAdmitted) {
        assertRequesterCurrent();
      }
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
