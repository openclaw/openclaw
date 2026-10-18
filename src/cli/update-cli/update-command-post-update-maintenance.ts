import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import {
  findServiceOwnershipRefusal,
  hasGatewayServiceStopUnsafeError,
} from "../../daemon/service-inspection-error.js";
import { GatewayServiceAuthorityError } from "../../daemon/service-update-authority.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { adoptCandidateManagedServiceStop } from "../../infra/update-candidate-predecessor-stop.js";
import { recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { defaultRuntime } from "../../runtime.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import { retireStandaloneGitWrapper } from "./update-command-git.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import {
  markControlPlaneUpdateRestartSentinelFailureBestEffort,
  prepareUpdateServiceResult,
  UpdateCommandPendingRecoveryFailure,
} from "./update-command-result.js";
import type { PreManagedServiceStop } from "./update-command-service-context-types.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";
import { createWindowsTaskAutoStartGuard } from "./update-command-service-maintenance.js";
import {
  maybeStopManagedServiceBeforeMutableUpdate,
  tryInstallShellCompletion,
} from "./update-command-service.js";
import { createPostUpdateFailureResult } from "./update-command-terminal-publication.js";

export async function preparePostUpdateService(
  params: FinishUpdateParams,
  assertCurrent: () => void,
): Promise<boolean> {
  assertCurrent();
  try {
    if (params.opts.run) {
      const run = params.opts.run;
      const { stopped, restartRequired } = await withOwnedManagedUpdateEnv(
        params.ownedManagedUpdateEnv,
        () =>
          adoptCandidateManagedServiceStop({
            transferred: params.preManagedServiceStop,
            shouldRestart: params.shouldRestart,
            mode: params.result.mode,
            status: params.result.status,
            runId: run.runId,
            ledger: { env: run.env },
            root: params.result.root ?? params.root,
            timeoutMs: params.updateStepTimeoutMs,
            assertCurrent,
            onStopped: (observed) => {
              params.preManagedServiceStop = observed;
            },
            onStep: (step) => params.result.steps.push(step),
          }),
      );
      assertCurrent();
      params.preManagedServiceStop = stopped;
      params.shouldRestart ||= restartRequired;
    }
  } catch (error) {
    if (
      hasCommandProcessCleanupError(error) ||
      hasGatewayServiceStopUnsafeError(error) ||
      findServiceOwnershipRefusal(error) ||
      collectNestedErrorCandidates(error).some(
        (cause) => cause instanceof GatewayServiceAuthorityError,
      )
    ) {
      throw error;
    }
    try {
      assertCurrent();
    } catch (authorityError) {
      if (authorityError === error) {
        throw error;
      }
      throw new AggregateError(
        [error, authorityError],
        `Service preparation failed (${formatErrorMessage(error)}) and update authority was lost (${formatErrorMessage(authorityError)}).`,
        { cause: authorityError },
      );
    }
    const cause = params.failure
      ? new AggregateError([params.failure.cause, error], "Update and service preparation failed", {
          cause: params.failure.cause,
        })
      : error;
    if (error instanceof UpdateCommandRecoveryPendingError) {
      throw new UpdateCommandPendingRecoveryFailure(params.result, formatErrorMessage(cause), {
        cause,
      });
    }
    const failure = createPostUpdateFailureResult(params, cause);
    params.result = failure.result;
    params.failure = { cause, detail: failure.message };
  }
  const shouldRestart = prepareUpdateServiceResult(params);
  if (params.opts.restart === false && !params.shouldRestart && params.opts.run) {
    assertCurrent();
    recordUpdateRunStep(
      params.opts.run.runId,
      { step: "restart", status: "skipped", endedAtMs: Date.now(), detail: "skipped by operator" },
      { env: params.opts.run.env },
    );
  }
  return shouldRestart;
}

export async function parkPostUpdateService(
  params: Pick<FinishUpdateParams, "opts" | "updateStepTimeoutMs">,
  context: {
    before: PreManagedServiceStop | undefined;
    root: string;
    mode: UpdateRunResult["mode"];
    updateRun: FinishUpdateParams["opts"]["run"];
    recordPhase: (phase: "activating") => Promise<void>;
    assertCurrent: () => void;
    onStopped: (state: PreManagedServiceStop) => void;
    onPrepared: (state: PreManagedServiceStop) => void;
  },
): Promise<PreManagedServiceStop> {
  const { before } = context;
  if (!before) {
    throw new Error("Plugin maintenance lost its update service owner.");
  }
  await before.windowsTaskAutoStartRecovery?.complete(true);
  // Full Doctor owns state migrations; retain this suspension through activation.
  const stopped = await maybeStopManagedServiceBeforeMutableUpdate({
    updateRun: context.updateRun,
    recordPhase: context.recordPhase,
    assertCurrent: context.assertCurrent,
    updateInstallKind: context.mode === "git" ? "git" : "package",
    root: context.root,
    shouldRestart: true,
    jsonMode: Boolean(params.opts.json),
    expectedService: before,
    phase: "prepare",
    timeoutMs: params.updateStepTimeoutMs,
    onStopped: context.onStopped,
  });
  context.assertCurrent();
  context.onPrepared(stopped);
  before.windowsTaskAutoStartRecovery = stopped.windowsTaskAutoStartRecovery;
  if (stopped.blockMessage || !stopped.stopped) {
    throw new Error(stopped.blockMessage ?? "Gateway could not be parked for plugin maintenance.");
  }
  stopped.windowsTaskAutoStartRecovery?.beginMutation();
  return stopped;
}

/** Shell integration changes follow settled restart and health recovery. */
export async function completePostUpdateMaintenance(
  params: FinishUpdateParams,
  result: UpdateRunResult,
  assertCurrent: () => void,
  context: {
    root: string;
    sentinel: Omit<
      Parameters<typeof markControlPlaneUpdateRestartSentinelFailureBestEffort>[0],
      "reason"
    >;
  },
): Promise<{ result: UpdateRunResult; detail: string } | undefined> {
  await tryInstallShellCompletion({
    root: context.root,
    jsonMode: Boolean(params.opts.json),
    skipPrompt: Boolean(params.opts.yes),
  });
  if (!params.installKindChanged || result.mode === "git") {
    return undefined;
  }
  const retirement = await retireStandaloneGitWrapper({
    previousRoot: params.previousInstallRoot ?? params.root,
    assertCurrent,
  });
  if (!retirement.error) {
    return undefined;
  }
  defaultRuntime.error(retirement.error);
  await markControlPlaneUpdateRestartSentinelFailureBestEffort({
    ...context.sentinel,
    reason: "wrapper-retirement-failed",
  });
  return {
    result: { ...result, status: "error", reason: "wrapper-retirement-failed" },
    detail: retirement.error,
  };
}

export async function resumePostUpdateWindowsAutoStart(
  params: Pick<FinishUpdateParams, "root" | "updateStepTimeoutMs">,
  result: UpdateRunResult,
  readStopped: () => PreManagedServiceStop | undefined,
  callbacks?: {
    beforeAttempt: () => void;
    onFailure: (cause: unknown) => Promise<unknown>;
  },
): Promise<void> {
  try {
    if (callbacks && readStopped()?.windowsTaskAutoStartRecovery) {
      callbacks.beforeAttempt();
    }
    const stopped = readStopped();
    await stopped?.windowsTaskAutoStartRecovery?.restore(
      true,
      createWindowsTaskAutoStartGuard({
        root:
          result.recovery?.packageRollbackVerified && stopped.serviceUpdateVerdict?.kind === "owned"
            ? stopped.serviceUpdateVerdict.root
            : (result.root ?? params.root),
        before: stopped,
        timeoutMs: params.updateStepTimeoutMs,
      }),
    );
  } catch (cause) {
    if (!callbacks) {
      throw cause;
    }
    // The attempted restore already failed; reporting must not attempt it again.
    await callbacks.onFailure(cause);
  }
}
