import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { collectUpdateDoctorFailureFacts } from "../../infra/update-doctor-result.js";
import { normalizeControlPlaneUpdateResult } from "../../infra/update-restart-sentinel-payload.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { defaultRuntime } from "../../runtime.js";
import { UPDATE_ACTIVATION_TIMEOUT_REASON } from "../../shared/update-outcome.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import { UpdateCommandFailure } from "./update-command-result.js";
import { GatewayRestartHealthError } from "./update-command-service-command.js";
import type { UpdateCommandTerminalRecord } from "./update-command-terminal-record.js";
import {
  publishUpdateCommandTerminalResult,
  resolveSettledUpdateCommandResult,
} from "./update-command-terminal.js";

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

export function createPostUpdateExceptionResult(
  params: Pick<FinishUpdateParams, "result" | "root" | "startedAt">,
  error: unknown,
  activationVerified = false,
): { result: UpdateRunResult; message: string } {
  const message = formatErrorMessage(error);
  const failureFacts = collectUpdateDoctorFailureFacts(error);
  if (
    activationVerified &&
    collectNestedErrorCandidates(error).every(
      (cause) =>
        cause instanceof GatewayRestartHealthError ||
        (cause instanceof UpdateCommandFailure &&
          cause.result.reason === "wrapper-retirement-failed" &&
          cause.result.recovery?.serviceRestartSafe !== false),
    ) &&
    error instanceof Error &&
    params.result.recovery?.serviceRestartSafe !== false
  ) {
    const warning =
      `Gateway activation verified; post-update maintenance needs attention: ${message} ` +
      "Inspect the reported launcher path and remove or replace the stale launcher, then run " +
      "`command -v openclaw` (or `Get-Command openclaw` on Windows) and `openclaw --version` " +
      "to confirm which installation is active.";
    return {
      message: warning,
      result: {
        ...params.result,
        status: "ok",
        reason: undefined,
        steps: [
          ...params.result.steps,
          {
            name: "post-update maintenance",
            command: "openclaw update",
            cwd: params.result.root ?? params.root,
            durationMs: Math.max(0, Date.now() - params.startedAt),
            exitCode: 0,
            advisory: { kind: "recoverable-maintenance", message: warning },
          },
        ],
      },
    };
  }
  return {
    message,
    result: {
      ...params.result,
      status: "error",
      reason: "post-update-failed",
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
