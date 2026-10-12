import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  markCronJobActive,
  noteActiveCronJobMessageActionAuthorityMutation,
  noteActiveCronJobMessageSourceAuthorityMutation,
  noteActiveCronJobScheduleMutation,
  type CronActiveJobMarker,
} from "../active-jobs.js";
import { resolveCronJobEffectiveAgentId } from "../agent-id.js";
import { CronRunReceiptRevisionError } from "../store/run-receipt-store.js";
import type { CronRunReceiptHandle, CronRunReceiptStatus } from "../store/run-receipt.types.js";
import type { CronAgentScope } from "../types-shared.js";
import type { CronJob, CronRunStatus } from "../types.js";
import {
  resolveCronJobMessageActionAuthorityInputs,
  resolveCronJobMessageToolAuthorityInputs,
} from "./jobs-tool-policy.js";
import type { CronServiceState } from "./state.js";
import { runsDetachedFromMainSession } from "./timer-execution-timeout.js";

function resolveCronRunReceiptAgentId(state: CronServiceState, job: CronAgentScope): string {
  return resolveCronJobEffectiveAgentId(
    job,
    state.deps.resolveDefaultAgentId
      ? state.deps.resolveDefaultAgentId()
      : state.deps.defaultAgentId,
  );
}

/** Both admission paths bind message permissions from the same canonical occurrence. */
export function markServiceCronJobActive(
  state: CronServiceState,
  job: CronJob,
  runReceipt: CronRunReceiptHandle,
): CronActiveJobMarker | undefined {
  const context = captureOpenClawStateWorkerContext();
  const assertOwner = () => {
    context.admission.assertCurrent();
    if (
      resolveCronRunReceiptAgentId(state, job) !== runReceipt.agentId ||
      state.deps.isAgentAvailable?.(runReceipt.agentId, undefined, {
        deletionBlocked: false,
      }) === false
    ) {
      throw new CronRunReceiptRevisionError(runReceipt.receiptId, "cron owner changed");
    }
  };
  const isCurrent = () => {
    try {
      assertOwner();
      return true;
    } catch {
      return false;
    }
  };
  const marker = markCronJobActive(job.id, {
    agentId: runReceipt.agentId,
    stateIdentityKey: context.admission.identity.key,
    preserveAcrossGenerationAdvance: !runsDetachedFromMainSession(job),
    isMessageActionAuthorityCurrent: resolveCronJobMessageToolAuthorityInputs(job)
      ? isCurrent
      : undefined,
    isMessageSourceAuthorityCurrent: resolveCronJobMessageActionAuthorityInputs(job)
      ? isCurrent
      : undefined,
  });
  if (marker) {
    marker.standingGrantAuthority = {
      context,
      handle: { ...runReceipt },
      assertCurrent: assertOwner,
    };
  }
  return marker;
}

export function publishCronRunReceiptMutation(params: {
  jobId: string;
  messageActionAuthorityChanged?: boolean;
  messageSourceAuthorityChanged?: boolean;
  scheduleChanged: boolean;
}): void {
  if (params.messageActionAuthorityChanged) {
    noteActiveCronJobMessageActionAuthorityMutation(params.jobId);
  }
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
