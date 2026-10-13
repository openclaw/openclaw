import type { TriageFailureContext } from "../../commands/triage-prompt.js";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveManagedServiceUpdateFailureExitCode } from "../../infra/update-control-plane-sentinel.js";
import {
  collectUpdateDoctorFailureFacts,
  DoctorMaintenanceRefusalError,
} from "../../infra/update-doctor-result.js";
import { normalizeControlPlaneUpdateResult } from "../../infra/update-restart-sentinel-payload.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { defaultRuntime } from "../../runtime.js";
import { UPDATE_ACTIVATION_TIMEOUT_REASON } from "../../shared/update-outcome.js";
import { createUpdateCommandAuthority } from "./update-command-authority.js";
import { createUpdateCommandExecutionGuards } from "./update-command-execution-guards.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import {
  captureMutableUpdateCompensation,
  withMutableUpdateForwardScope,
  recordMutableUpdateInterruption,
} from "./update-command-mutable-signals.js";
import { createUpdateCommandFinalizationFence } from "./update-command-recovery.js";
import { resolveAutomaticUpdateTriage, UpdateCommandFailure } from "./update-command-result.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";
import type { UpdateCommandTerminalRecord } from "./update-command-terminal-record.js";
import {
  publishUpdateCommandTerminalResult,
  resolveSettledUpdateCommandResult,
} from "./update-command-terminal.js";

export function captureUpdateFinalization(params: FinishUpdateParams) {
  const fence = createUpdateCommandFinalizationFence(params);
  const assertCurrent = params.opts.run?.requesterAuthority
    ? createUpdateCommandAuthority({ opts: params.opts, assertCurrent: fence }).assertCurrent
    : fence;
  const { recordPhase } = createUpdateCommandExecutionGuards(params.opts, params.root, {
    kind: "current-core-finalization",
    assertCurrent,
  });
  return {
    fence,
    assertCurrent,
    recordPhase,
    originalRun: params.opts.run,
    compensate: captureMutableUpdateCompensation(params.opts),
    forward: <T>(work: () => Promise<T>) =>
      withMutableUpdateForwardScope(params.opts, () =>
        withOwnedManagedUpdateEnv(params.ownedManagedUpdateEnv, work),
      ),
    interruptedResult: (result: UpdateRunResult) =>
      recordMutableUpdateInterruption(params.opts, result),
    beganSuccessfully: params.result.status === "ok",
    // Publication follows environment restoration; retain the admitted notice and sentinel scope.
    sentinelOptions: {
      meta: params.controlPlaneUpdateSentinelMeta,
      jsonMode: Boolean(params.opts.json),
      env: params.opts.run?.env ?? params.ownedManagedUpdateEnv,
    },
  };
}

export async function withUpdateProgressSettlement(
  params: FinishUpdateParams,
  settle: (() => Promise<void>) | undefined,
  finalize: (params: FinishUpdateParams, failure?: { cause: unknown }) => Promise<UpdateRunResult>,
): Promise<UpdateRunResult> {
  let settledParams = params;
  let failure: { cause: unknown } | undefined;
  try {
    if (settle) {
      await settle();
    }
  } catch (cause) {
    // A settled receipt refusal must not bypass owned rollback. Uncertain writers still fence it.
    if (hasCommandProcessCleanupError(cause)) {
      throw cause;
    }
    failure = { cause };
    const { result } = createPostUpdateFailureResult(params, cause);
    settledParams = {
      ...params,
      result:
        params.result.status === "error" ? { ...result, reason: params.result.reason } : result,
    };
  }
  try {
    const result = await finalize(settledParams, failure);
    if (failure) {
      throw new UpdateCommandFailure(result, 1, undefined, { cause: failure.cause });
    }
    return result;
  } catch (cause) {
    if (failure && !collectNestedErrorCandidates(cause).includes(failure.cause)) {
      throw new AggregateError(
        [cause, failure.cause],
        "Update finalization and progress reporting failed",
        { cause },
      );
    }
    throw cause;
  }
}

export function bindUpdateFinalizationFailure(
  params: FinishUpdateParams,
  progressFailure: { cause: unknown } | undefined,
  readTriage: () => { triageAllowed: boolean; gateway: TriageFailureContext["gateway"] },
) {
  return (
    result: UpdateRunResult,
    detail?: string,
    options?: ErrorOptions,
    exitCode = resolveManagedServiceUpdateFailureExitCode(result),
  ) => {
    const { triageAllowed, gateway } = readTriage();
    const failureOptions =
      progressFailure &&
      !collectNestedErrorCandidates(options?.cause).includes(progressFailure.cause)
        ? {
            cause:
              options && "cause" in options
                ? new AggregateError(
                    [options.cause, progressFailure.cause],
                    "Update and progress reporting failed",
                  )
                : progressFailure.cause,
          }
        : options;
    return new UpdateCommandFailure(result, exitCode, detail, {
      ...failureOptions,
      automaticTriage: triageAllowed
        ? resolveAutomaticUpdateTriage(result, detail, { ...params, gateway })
        : undefined,
    });
  };
}

export function completeUpdateCommandResult(
  params: Pick<FinishUpdateParams, "startedAt" | "rollbackBlockedReason">,
  result: UpdateRunResult,
  serviceStop?: FinishUpdateParams["preManagedServiceStop"],
): UpdateRunResult {
  if (
    serviceStop?.stopped &&
    serviceStop.serviceMembershipSourceAbsent &&
    !result.steps.some((step) => step.name === "managed-service-membership")
  ) {
    const message =
      "Service membership unverifiable on this host; using managed stop/update/start.";
    defaultRuntime.error(message);
    result.steps.push({
      name: "managed-service-membership",
      command: "openclaw update",
      cwd: result.root ?? "",
      durationMs: 0,
      exitCode: 0,
      advisory: { kind: "recoverable-maintenance", message },
    });
  }
  return normalizeControlPlaneUpdateResult({
    ...result,
    ...(result.status === "error" &&
    result.reason !== UPDATE_ACTIVATION_TIMEOUT_REASON &&
    params.rollbackBlockedReason
      ? { reason: params.rollbackBlockedReason }
      : {}),
    durationMs: Math.max(0, Date.now() - params.startedAt),
  });
}

export async function publishSettledUpdateCommandResult(
  params: Pick<
    FinishUpdateParams,
    | "opts"
    | "root"
    | "ownedManagedUpdateEnv"
    | "coreAlreadyCurrent"
    | "startedAt"
    | "rollbackBlockedReason"
  >,
  state: {
    pendingResult: UpdateRunResult;
    failure?: unknown;
    terminalRecord?: UpdateCommandTerminalRecord;
    readReportingState: () => {
      notify?: (result: UpdateRunResult) => Promise<void>;
      rolledBack: boolean;
      pendingRestartAtMs?: number;
      completedDowntimeMs?: number;
    };
  },
  onTerminalRecord?: (record: UpdateCommandTerminalRecord["record"]) => void,
): Promise<UpdateRunResult> {
  const settled = await resolveSettledUpdateCommandResult(
    params,
    state.pendingResult,
    state.failure,
    state.terminalRecord,
  );
  const result = completeUpdateCommandResult(params, settled.result);
  result.recovery = settled.settlementFailed ? undefined : result.recovery;
  const reporting = state.readReportingState();
  const reportDowntime = !settled.settlementFailed && reporting.pendingRestartAtMs === undefined;
  if (reporting.notify) {
    await reporting.notify(result);
  }
  // Notification can yield. Preserve the finalizer's original observation points.
  const { rolledBack, completedDowntimeMs } = state.readReportingState();
  return publishUpdateCommandTerminalResult(
    params,
    result,
    {
      rolledBack: rolledBack && !settled.settlementFailed,
      downtimeMs: reportDowntime ? completedDowntimeMs : undefined,
      captured: settled.captured,
    },
    onTerminalRecord,
  );
}

export function createPostUpdateFailureResult(
  params: Pick<FinishUpdateParams, "result" | "root" | "startedAt">,
  error: unknown,
): { result: UpdateRunResult; message: string } {
  const message = formatErrorMessage(error);
  const failureFacts = collectUpdateDoctorFailureFacts(error);
  const dataAtRisk = collectNestedErrorCandidates(error).some(
    (cause) =>
      cause instanceof DoctorMaintenanceRefusalError && cause.refusal.kind === "data-at-risk",
  );
  return {
    message,
    result: {
      ...params.result,
      status: "error",
      reason: "post-update-failed",
      ...(dataAtRisk
        ? {
            recovery: {
              serviceRestartSafe: false as const,
              reason: "runtime-verification-failed" as const,
            },
          }
        : {}),
      steps: [
        ...params.result.steps,
        {
          name: "post-update verification",
          command: "openclaw update",
          cwd: params.result.root ?? params.root,
          durationMs: Math.max(0, Date.now() - params.startedAt),
          exitCode: 1,
          stderrTail: message,
          ...(failureFacts.length ? { failureFacts } : {}),
        },
      ],
    },
  };
}
