import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { acquireWithWait } from "../../infra/acquire-with-wait.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isStateDatabaseMaintenanceContention } from "../../infra/gateway-state-owner-record.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import { UpdatePreMutationError } from "../../infra/update-pre-mutation-error.js";
import { UpdateRequesterRevokedError } from "../../infra/update-requester-authority.js";
import type { UpdateRunPhasePatch } from "../../infra/update-run-mutation.types.js";
import type { UpdateRunPhase, UpdateRunStep } from "../../infra/update-run-record.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import {
  recordUpdateRunPhaseAsync,
  recordUpdateRunStepAsync,
  type UpdateRunWriteOptions,
} from "../../infra/update-run-write.async.js";
import { resolveCommandProcessSignal } from "../../process/exec-spawn.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { sleep } from "../../utils/sleep.js";
import type { UpdateCommandOptions } from "./shared.js";
import type { UpdateCommandExecutionGuards } from "./update-command-execution.types.js";
import { captureUpdateCommandExecutorAuthority } from "./update-command-executor.js";
import {
  recordMutableUpdateSignalPhase,
  retainMutableUpdateSignalWrite,
} from "./update-command-mutable-signals.js";
import { assertUpdateCommandRecoveryState } from "./update-command-recovery.js";

type PhaseOwner = Readonly<{
  kind: "current-core-finalization" | "package-compensation";
  assertCurrent: () => void;
}>;
type PhaseWriter = Pick<UpdateCommandExecutionGuards, "recordPhase">;

export function createUpdateCommandExecutionGuards(
  opts: UpdateCommandOptions,
  root: string,
  owner: PhaseOwner,
): PhaseWriter;
export function createUpdateCommandExecutionGuards(
  opts: UpdateCommandOptions,
  root: string,
): UpdateCommandExecutionGuards;
/** Pin the invocation across parent work and the separately bound Doctor child. */
export function createUpdateCommandExecutionGuards(
  opts: UpdateCommandOptions,
  root: string,
  owner?: PhaseOwner,
) {
  const run = opts.run;
  let executor = run?.executorFence;
  const requester = run?.requesterAuthority;
  let stateHandedOff = false;
  const assertInvocation = (phase?: "restore") => {
    const readStatePolicy = !stateHandedOff && phase !== "restore";
    if (readStatePolicy && requester?.isCurrent() === false) {
      throw new UpdateRequesterRevokedError();
    }
    if (opts.recovery || readStatePolicy) {
      assertUpdateCommandRecoveryState(opts);
    }
  };
  const assertForwardCurrent = () => {
    run?.deadline?.remainingMs();
    run?.deadline?.signal.throwIfAborted();
    if (run?.interrupted) {
      throw new UpdateRequesterRevokedError();
    }
  };
  const assertCurrent = (phase?: "restore") => {
    if (phase !== "restore") {
      assertForwardCurrent();
    }
    executor?.assertCurrent();
    assertInvocation(phase);
  };
  const waitForCurrent = async () => {
    // Only retry the read, never the mutation it protects. Keep cancellation and
    // retained executor authority live while another process owns maintenance.
    const deadline = run?.deadline;
    const deadlineMs = Math.min(performance.now() + 30_000, deadline?.deadlineMs ?? Infinity);
    const signal = resolveCommandProcessSignal(deadline?.signal);
    let contention: unknown;
    try {
      await acquireWithWait({
        acquire: () => {
          signal?.throwIfAborted();
          assertCurrent();
        },
        shouldRetry: (error) => {
          if (!isStateDatabaseMaintenanceContention(error)) {
            return false;
          }
          contention = error;
          return true;
        },
        deadlineMs,
        pollIntervalMs: 50,
        maxPollIntervalMs: 250,
        sleep: (ms) => sleep(ms, signal),
      });
    } catch (cause) {
      const deadlineExpired =
        deadline?.timeout &&
        (cause === deadline.signal.reason ||
          (cause instanceof Error && cause.cause === deadline.signal.reason));
      const maintenance = isStateDatabaseMaintenanceContention(cause)
        ? cause
        : deadlineExpired
          ? contention
          : undefined;
      if (!maintenance) {
        throw cause;
      }
      throw new UpdatePreMutationError(
        "state-maintenance-busy",
        `Update deferred while waiting for state maintenance. ${formatErrorMessage(maintenance)} Let the maintenance owner finish, then retry openclaw update.`,
        { cause },
      );
    }
  };
  const captureWriteOptions = (): ReturnType<
    UpdateCommandExecutionGuards["captureWriteOptions"]
  > => {
    const assertAccepting = () => {
      if (owner?.kind !== "package-compensation" && run?.interrupted) {
        throw new UpdateRequesterRevokedError();
      }
    };
    assertAccepting();
    const capturedEnv = cloneEnvWithPlatformSemantics(run?.env ?? process.env);
    const context = captureOpenClawStateWorkerContext({ env: capturedEnv });
    return {
      env: capturedEnv,
      context,
      // Driver-only wait; these writes run in the worker, never on the Gateway event loop.
      busyTimeoutMs: run?.busyTimeoutMs ?? 120_000,
      assertAccepting,
      retainSettlement: (completion: Promise<void>) =>
        retainMutableUpdateSignalWrite(run, completion),
      ...(owner || !stateHandedOff ? { requireNoRecovery: true as const } : {}),
    } satisfies UpdateRunWriteOptions;
  };
  const recordPhase = async (phase: UpdateRunPhase, patch?: UpdateRunPhasePatch) => {
    if (run) {
      owner?.assertCurrent();
      const captured = captureWriteOptions();
      await recordUpdateRunPhaseAsync(run.runId, phase, patch, captured);
      recordMutableUpdateSignalPhase(run, phase);
    }
  };
  if (owner) {
    return { recordPhase };
  }
  return {
    captureWriteOptions,
    recordPhase,
    recordStep: async (step: UpdateRunStep) => {
      if (!run) {
        throw new Error("Update step receipt requires an admitted run.");
      }
      const captured = captureWriteOptions();
      return await recordUpdateRunStepAsync(run.runId, step, captured);
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
      run.executorFence = acquired;
      executor = acquired;
    },
    // Forward admission already checked policy. Compensation retains native
    // custody in a separate lease database while the source family is excluded.
    assertCurrent,
    waitForCurrent,
    // This is not native authority. The Doctor caller must first bind its child
    // through the real executor, which checks both retained and candidate owners.
    assertBoundChildCurrent: () => {
      assertForwardCurrent();
      assertInvocation();
    },
  };
}
