import { formatErrorMessage } from "../../infra/errors.js";
import { collectUpdateDoctorFailureFacts } from "../../infra/update-doctor-result.js";
import { normalizeControlPlaneUpdateResult } from "../../infra/update-restart-sentinel-payload.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { UPDATE_ACTIVATION_TIMEOUT_REASON } from "../../shared/update-outcome.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import type { UpdateCommandTerminalRecord } from "./update-command-terminal-record.js";
import {
  publishUpdateCommandTerminalResult,
  resolveSettledUpdateCommandResult,
} from "./update-command-terminal.js";

export function completeUpdateCommandResult(
  params: Pick<FinishUpdateParams, "startedAt" | "rollbackBlockedReason">,
  result: UpdateRunResult,
): UpdateRunResult {
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
