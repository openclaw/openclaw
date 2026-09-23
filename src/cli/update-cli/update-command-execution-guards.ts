import { resolveConfigPath } from "../../config/paths.js";
import { assertUpdateWriteAuthority } from "../../infra/update-freebsd-write-admission.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import { UpdateRequesterRevokedError } from "../../infra/update-requester-authority.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { UpdateCommandOptions } from "./shared.js";
import { captureUpdateCommandExecutorAuthority } from "./update-command-executor.js";
import { assertUpdateCommandRecoveryState } from "./update-command-recovery.js";

/** Pin the invocation across parent work and the separately bound Doctor child. */
export function createUpdateCommandExecutionGuards(opts: UpdateCommandOptions, root: string) {
  const run = opts.run;
  const runId = run?.runId;
  const env = run?.env;
  const selectors = run?.freebsdWriteAdmission
    ? { state: resolveOpenClawStateSqlitePath(env), config: resolveConfigPath(env) }
    : undefined;
  let executor = run?.executorFence;
  const requester = run?.requesterAuthority;
  let stateHandedOff = false;
  const assertInvocation = () =>
    assertUpdateWriteAuthority(run?.freebsdWriteAdmission, () => {
      // Compare the admitted selection before any old-schema read. This accepts
      // every original user/profile path; a later selector cannot redirect the run.
      if (
        selectors &&
        (opts.run !== run ||
          run?.env !== env ||
          resolveOpenClawStateSqlitePath(env) !== selectors.state ||
          resolveConfigPath(env) !== selectors.config)
      ) {
        throw new UpdateRequesterRevokedError();
      }
      // Doctor owns migrated SQLite; the independent write latch still gates effects.
      run?.freebsdWriteAdmission?.assertCurrent();
      if (opts.recovery || !stateHandedOff) {
        assertUpdateCommandRecoveryState(opts);
      }
      if (
        opts.run !== run ||
        run?.runId !== runId ||
        run?.executorFence !== executor ||
        run?.requesterAuthority !== requester ||
        (!stateHandedOff && requester?.isCurrent() === false)
      ) {
        throw new UpdateRequesterRevokedError();
      }
    });
  return {
    onStateHandoff: () => {
      stateHandedOff = true;
    },
    // Only the mutable-preparation owner calls this, immediately after enter().
    // Never infer admission from a newly observed mutable run.executorFence.
    admitExecutor: (acquired: UpdateRecoveryFence) =>
      assertUpdateWriteAuthority(run?.freebsdWriteAdmission, () => {
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
      }),
    assertCurrent: () =>
      assertUpdateWriteAuthority(run?.freebsdWriteAdmission, () => {
        assertInvocation();
        executor?.assertCurrent();
      }),
    // This is not native authority. The Doctor caller must first bind its child
    // through the real executor, which checks both retained and candidate owners.
    assertBoundChildCurrent: assertInvocation,
  };
}
