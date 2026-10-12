import { isDeepStrictEqual } from "node:util";
import {
  noteActiveCronJobTriggerMutation,
  requestActiveCronJobCancellation,
} from "../active-jobs.js";
import { resolveCronJobEffectiveAgentId } from "../agent-id.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { cronSchedulingInputsEqual } from "../schedule-identity.js";
import type { CronJobMutation, CronJobMutationSnapshot } from "../store/job-mutations.types.js";
import {
  resolveCronAuthenticatedCallerOrigin,
  resolveCronAuthenticatedChannelRequester,
} from "../tools-allow-provenance.js";
import type { CronJob } from "../types.js";
import { findJobOrThrow, isJobEnabled } from "./jobs-scheduling.js";
import {
  cronJobMessageActionAuthorityInputsEqual,
  cronJobMessageToolAuthorityInputsEqual,
} from "./jobs-tool-policy.js";
import { publishCronRunReceiptMutation, type CronRunReceiptOwnerMutation } from "./run-receipts.js";
import { emit, type CronServiceState } from "./state.js";
import { persistCronJobMutation, type captureCronJobMutationSource } from "./store.js";

export async function persistUpdatedJob(params: {
  state: CronServiceState;
  previousJob: CronJob;
  nextJob: CronJob;
  source: ReturnType<typeof captureCronJobMutationSource>;
  mutationMethod: "cron.add" | "cron.update";
  ownerMutation?: CronRunReceiptOwnerMutation;
  commitGuard?: () => void;
  agentId?: string;
  preconditionJob?: CronJob;
  jobMutation: CronJobMutation;
  jobMutationSnapshot: CronJobMutationSnapshot;
}) {
  const { state, previousJob, nextJob } = params;
  const defaultAgentId = state.deps.resolveDefaultAgentId
    ? state.deps.resolveDefaultAgentId()
    : state.deps.defaultAgentId;
  resolveCronJobEffectiveAgentId(previousJob, defaultAgentId);
  resolveCronJobEffectiveAgentId(nextJob, defaultAgentId);

  const triggerStateChanged =
    !isDeepStrictEqual(previousJob.trigger, nextJob.trigger) ||
    !isDeepStrictEqual(previousJob.state.triggerState, nextJob.state.triggerState) ||
    ((previousJob.payload.kind === "script" || nextJob.payload.kind === "script") &&
      !isDeepStrictEqual(previousJob.payload, nextJob.payload));
  const scheduleChanged = !cronSchedulingInputsEqual(previousJob, nextJob);
  const messageActionAuthorityChanged =
    (isJobEnabled(previousJob) && !isJobEnabled(nextJob)) ||
    !cronJobMessageToolAuthorityInputsEqual(previousJob, nextJob);
  const messageSourceAuthorityChanged =
    !cronJobMessageActionAuthorityInputsEqual(previousJob, nextJob) ||
    (triggerStateChanged &&
      Boolean(
        resolveCronAuthenticatedChannelRequester(previousJob) ||
        resolveCronAuthenticatedChannelRequester(nextJob) ||
        resolveCronAuthenticatedCallerOrigin(previousJob) ||
        resolveCronAuthenticatedCallerOrigin(nextJob),
      ));
  await persistCronJobMutation({
    state,
    source: params.source,
    method: params.mutationMethod,
    assertCurrent: () => {
      params.commitGuard?.();
      params.ownerMutation?.assertCurrent();
      const currentDefaultAgentId = state.deps.resolveDefaultAgentId
        ? state.deps.resolveDefaultAgentId()
        : state.deps.defaultAgentId;
      resolveCronJobEffectiveAgentId(previousJob, currentDefaultAgentId);
      resolveCronJobEffectiveAgentId(nextJob, currentDefaultAgentId);
    },
    agentId: params.agentId,
    preconditionJob: params.preconditionJob,
    expectedJob: { id: previousJob.id, configRevision: resolveCronJobConfigRevision(previousJob) },
    jobMutation: params.jobMutation,
    jobMutationSnapshot: params.jobMutationSnapshot,
    suppressScheduledJobId: nextJob.id,
    receiptMutation: {
      jobId: nextJob.id,
      owner: params.ownerMutation?.prepared,
      triggerStateChanged,
      scheduleChanged,
    },
    afterCommit: () => {
      publishCronRunReceiptMutation({
        jobId: nextJob.id,
        messageActionAuthorityChanged,
        messageSourceAuthorityChanged,
        scheduleChanged,
      });
      try {
        if (isJobEnabled(previousJob) && !isJobEnabled(nextJob)) {
          requestActiveCronJobCancellation(nextJob.id, "Cron job disabled by operator.");
        }
      } finally {
        if (triggerStateChanged) {
          noteActiveCronJobTriggerMutation(nextJob.id);
        }
      }
    },
    afterPublish: () => {
      const committedJob = findJobOrThrow(state, nextJob.id);
      emit(state, {
        jobId: nextJob.id,
        action: "updated",
        job: committedJob,
        nextRunAtMs: committedJob.state.nextRunAtMs,
      });
    },
  });
  return findJobOrThrow(state, nextJob.id);
}
