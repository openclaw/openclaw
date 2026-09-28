import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import { UpdateRequesterRevokedError } from "../../infra/update-requester-authority.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import type { UpdateCommandOptions } from "./shared.js";
import { captureUpdateCommandExecutorAuthority } from "./update-command-executor.js";
import { assertUpdateCommandRecoveryState } from "./update-command-recovery.js";

/** Pin the invocation across parent work and the separately bound Doctor child. */
export function createUpdateCommandExecutionGuards(opts: UpdateCommandOptions, root: string) {
  const run = opts.run;
  const runId = run?.runId;
  let executor = run?.executorFence;
  const requester = run?.requesterAuthority;
  let stateHandedOff = false;
  const assertInvocation = (phase?: "restore") => {
    const readStatePolicy = !stateHandedOff && phase !== "restore";
    if (opts.recovery || readStatePolicy) {
      assertUpdateCommandRecoveryState(opts);
    }
    if (
      opts.run !== run ||
      run?.runId !== runId ||
      run?.executorFence !== executor ||
      run?.requesterAuthority !== requester ||
      (readStatePolicy && requester?.isCurrent() === false)
    ) {
      throw new UpdateRequesterRevokedError();
    }
  };
  return {
    onStateHandoff: () => {
      stateHandedOff = true;
    },
    // Only the mutable-preparation owner calls this, immediately after enter().
    // Never infer admission from a newly observed mutable run.executorFence.
    admitExecutor: (acquired: UpdateRecoveryFence) => {
      assertInvocation();
      if (!run || (executor && acquired !== executor)) {
        throw new UpdateRequesterRevokedError();
      }
      const authority = captureUpdateCommandExecutorAuthority(acquired, run.runId);
      if (authority.installKey !== resolveUpdateInstallRoot(root)) {
        throw new UpdateRequesterRevokedError();
      }
      assertUpdateCommandRecoveryState(opts);
      run.executorFence = acquired;
      executor = acquired;
    },
    // Forward admission already checked policy. Compensation retains native
    // custody in a separate lease database while the source family is excluded.
    assertCurrent: (phase?: "restore") => {
      assertInvocation(phase);
      executor?.assertCurrent();
    },
    // This is not native authority. The Doctor caller must first bind its child
    // through the real executor, which checks both retained and candidate owners.
    assertBoundChildCurrent: () => assertInvocation(),
  };
}
