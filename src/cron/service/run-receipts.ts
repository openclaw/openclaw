import { parseExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import { toAgentStoreSessionKey } from "../../routing/session-key.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import {
  markCronJobActive,
  noteActiveCronJobMessageSourceAuthorityMutation,
  noteActiveCronJobScheduleMutation,
  type CronActiveJobMarker,
} from "../active-jobs.js";
import { resolveCronSessionTargetSessionKey } from "../session-target.js";
import type { CronRunReceiptHandle, CronRunReceiptStatus } from "../store/run-receipt.types.js";
import type { CronJob, CronRunStatus } from "../types.js";
import type { CronExecutionIdentityAdmission, CronServiceState } from "./state.js";
import { runsDetachedFromMainSession } from "./timer-execution-timeout.js";

export function createCronReceiptExecutionIdentity(
  state: CronServiceState,
  receipt: CronRunReceiptHandle,
  context: OpenClawStateWorkerContext,
): CronExecutionIdentityAdmission {
  const { jobId, receiptId } = receipt;
  let executionBinding: Promise<void> | undefined;
  return {
    ingress: { kind: "schedule", boundary: "cron.isolated-agent", state: "present" },
    async onPostAdmission(admitted) {
      const token = admitted.executionIdentityToken;
      if (!token) {
        return;
      }
      // Trigger and payload admissions share one diagnostic link, never receipt authority.
      executionBinding ??= Promise.resolve()
        .then(async () => {
          const binding = parseExecutionIdentityAdmissionToken(token);
          if (binding.runId !== admitted.operationalRunInstance.runId) {
            throw new Error("Cron execution identity does not match its admitted run");
          }
          const retained = await runOpenClawStateWorkerOperation(context, (scope) =>
            scope.execute({
              type: "cron.bindReceiptExecution",
              input: {
                receiptId,
                binding: { contextId: binding.contextId, executionId: binding.executionId },
              },
            }),
          );
          if (!retained) {
            throw new Error("Cron execution identity binding was not retained");
          }
        })
        .catch((error: unknown) => {
          state.deps.log.warn(
            { err: String(error), jobId },
            "cron: failed to retain execution identity binding",
          );
        });
      await executionBinding;
    },
  };
}

/** Both admission paths bind activity to the same canonical occurrence. */
export function markServiceCronJobActive(
  job: CronJob,
  runReceipt: CronRunReceiptHandle,
): CronActiveJobMarker | undefined {
  const context = captureOpenClawStateWorkerContext();
  const sessionKey = resolveCronSessionTargetSessionKey(job.sessionTarget);
  const marker = markCronJobActive(job.id, {
    agentId: runReceipt.agentId,
    sessionKey: sessionKey
      ? toAgentStoreSessionKey({ agentId: runReceipt.agentId, requestKey: sessionKey })
      : undefined,
    stateIdentityKey: context.admission.identity.key,
    preserveAcrossGenerationAdvance: !runsDetachedFromMainSession(job),
  });
  return marker;
}

export function publishCronRunReceiptMutation(params: {
  jobId: string;
  messageSourceAuthorityChanged?: boolean;
  scheduleChanged: boolean;
}): void {
  if (params.messageSourceAuthorityChanged) {
    noteActiveCronJobMessageSourceAuthorityMutation(params.jobId);
  }
  if (params.scheduleChanged) {
    noteActiveCronJobScheduleMutation(params.jobId);
  }
}

export function resolveCronRunReceiptTerminalStatus(
  status: CronRunStatus,
  triggerFired?: boolean,
): Exclude<CronRunReceiptStatus, "running"> {
  if (status === "ok") {
    return triggerFired === false ? "skipped" : "ok";
  }
  return status === "skipped" ? "skipped" : "error";
}
