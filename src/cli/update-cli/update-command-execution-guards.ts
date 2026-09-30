import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import { UpdateRequesterRevokedError } from "../../infra/update-requester-authority.js";
import type { UpdateRunPhasePatch } from "../../infra/update-run-mutation.types.js";
import type { UpdateRunPhase } from "../../infra/update-run-record.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import {
  recordUpdateRunPhaseAsync,
  type UpdateRunWriteOptions,
} from "../../infra/update-run-write.async.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { UpdateCommandOptions } from "./shared.js";
import { captureUpdateCommandExecutorAuthority } from "./update-command-executor.js";
import { retainMutableUpdateSignalWrite } from "./update-command-mutable-signals.js";
import { assertUpdateCommandRecoveryState } from "./update-command-recovery.js";

/** Pin the invocation across parent work and the separately bound Doctor child. */
export function createUpdateCommandExecutionGuards(opts: UpdateCommandOptions, root: string) {
  const run = opts.run;
  const runId = run?.runId;
  let executor = run?.executorFence;
  const requester = run?.requesterAuthority;
  let stateHandedOff = false;
  const assertInvocation = (phase?: "restore", readRecovery = true) => {
    const readStatePolicy = !stateHandedOff && phase !== "restore";
    if (opts.recovery || (readRecovery && readStatePolicy)) {
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
  const captureWriteOptions = () => {
    const assertAccepting = () => {
      if (run?.interrupted) {
        throw new UpdateRequesterRevokedError();
      }
    };
    assertAccepting();
    const capturedExecutor = executor;
    const capturedHandoff = stateHandedOff;
    const env = run?.env;
    const assertCurrent = () => {
      if (executor !== capturedExecutor || stateHandedOff !== capturedHandoff || run?.env !== env) {
        throw new UpdateRequesterRevokedError();
      }
      assertInvocation(undefined, false);
      capturedExecutor?.assertCurrent();
    };
    assertCurrent();
    const capturedEnv = cloneEnvWithPlatformSemantics(env ?? process.env);
    const context = captureOpenClawStateWorkerContext({ env: capturedEnv });
    return {
      env: capturedEnv,
      context,
      assertCurrent,
      assertAccepting,
      retainSettlement: (completion: Promise<void>) =>
        retainMutableUpdateSignalWrite(run, completion),
      ...(!capturedHandoff ? { requireNoRecovery: true as const } : {}),
    } satisfies UpdateRunWriteOptions;
  };
  return {
    captureWriteOptions,
    recordPhase: async (phase: UpdateRunPhase, patch?: UpdateRunPhasePatch) => {
      if (run) {
        await recordUpdateRunPhaseAsync(run.runId, phase, patch, captureWriteOptions());
      }
    },
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
      if (phase !== "restore" && run?.interrupted) {
        throw new UpdateRequesterRevokedError();
      }
      assertInvocation(phase);
      executor?.assertCurrent();
    },
    // This is not native authority. The Doctor caller must first bind its child
    // through the real executor, which checks both retained and candidate owners.
    assertBoundChildCurrent: () => assertInvocation(),
  };
}
