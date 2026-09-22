/** Completes a canonical job edit before authority rebinding and persistence. */
import { isDeepStrictEqual } from "node:util";
import { isCronJobActive } from "../active-jobs.js";
import { cronSchedulingInputsEqual } from "../schedule-identity.js";
import { createCronStreamSourceIdentity, cronStreamScheduleKey } from "../stream-schedule.js";
import type { CronJob, CronJobPatch, CronStoredJob } from "../types.js";
import { computeJobNextRunAtMs, hasScheduledNextRunAtMs, isJobEnabled } from "./jobs-scheduling.js";

/** Keep the harness-owned immutable envelope intact when copying mutable job fields. */
export function cloneCronJobForMutation(job: CronStoredJob): CronStoredJob {
  const { runtimeAuthority, ...mutableJob } = job;
  // structuredClone changes null-prototype JSON objects, which would make an
  // unchanged declaration look different and discard the envelope's immutability.
  return { ...structuredClone(mutableJob), ...(runtimeAuthority ? { runtimeAuthority } : {}) };
}

function reconcileStreamSourceIdentity(job: CronJob, nextJob: CronJob): void {
  if (nextJob.schedule.kind !== "stream") {
    nextJob.state.streamSourceIdentity = undefined;
    return;
  }
  const sourceChanged =
    job.schedule.kind !== "stream" ||
    cronStreamScheduleKey(job.schedule) !== cronStreamScheduleKey(nextJob.schedule) ||
    isJobEnabled(job) !== isJobEnabled(nextJob);
  const currentIdentity =
    job.schedule.kind === "stream" ? job.state.streamSourceIdentity : undefined;
  nextJob.state.streamSourceIdentity =
    sourceChanged || !currentIdentity ? createCronStreamSourceIdentity() : currentIdentity;
}

export function finalizeUpdatedJob(params: {
  job: CronJob;
  nextJob: CronJob;
  now: number;
  schedulingInputsRequested: boolean;
  scheduleChanged: boolean;
  explicitTriggerState?: CronJobPatch["state"];
}) {
  const { job, nextJob, now } = params;
  if (nextJob.schedule.kind === "every") {
    const anchor = nextJob.schedule.anchorMs;
    if (typeof anchor !== "number" || !Number.isFinite(anchor)) {
      // Inherit the previous cadence anchor only for an unchanged-interval
      // re-save (UIs resubmit the schedule without the internal anchorMs).
      // Without this an idempotent edit re-phases the job to now, shifting
      // every future fire time and skipping an already-due slot. A genuine
      // interval change still anchors to the edit time so the new cadence
      // starts now, matching the prior update semantics.
      const previousAnchorMs =
        job.schedule.kind === "every" &&
        job.schedule.everyMs === nextJob.schedule.everyMs &&
        typeof job.schedule.anchorMs === "number" &&
        Number.isFinite(job.schedule.anchorMs)
          ? job.schedule.anchorMs
          : undefined;
      const fallbackAnchorMs =
        previousAnchorMs ??
        (params.scheduleChanged
          ? now
          : typeof nextJob.createdAtMs === "number" && Number.isFinite(nextJob.createdAtMs)
            ? nextJob.createdAtMs
            : now);
      nextJob.schedule = {
        ...nextJob.schedule,
        anchorMs: Math.max(0, Math.floor(fallbackAnchorMs)),
      };
    }
  }
  // Source identity belongs to the durable job mutation, not the process
  // watcher. Equivalent resaves preserve it; disable/enable and source changes
  // rotate it in the same write that changes the public job definition.
  reconcileStreamSourceIdentity(job, nextJob);

  const previousScript = job.payload.kind === "script" ? job.payload.script : undefined;
  const nextScript = nextJob.payload.kind === "script" ? nextJob.payload.script : undefined;
  if (!isDeepStrictEqual(job.trigger, nextJob.trigger) || previousScript !== nextScript) {
    // Trigger and payload scripts share one durable state slot. Exact persisted
    // definitions own it, matching in-flight ownership; explicit replacements win.
    for (const field of [
      "triggerState",
      "triggerEvalCount",
      "lastTriggerEvalAtMs",
      "lastTriggerFireAtMs",
    ] as const) {
      if (params.explicitTriggerState && Object.hasOwn(params.explicitTriggerState, field)) {
        Object.assign(nextJob.state, { [field]: params.explicitTriggerState[field] });
      } else {
        delete nextJob.state[field];
      }
    }
  }

  // Only advance a recurring job's next run when the schedule/enabled inputs
  // actually changed. An idempotent re-save (same schedule, or re-enabling an
  // already-enabled job) must preserve a still-due slot, matching the
  // add/remove maintenance recompute; otherwise the pending run is dropped.
  const schedulingInputsChanged =
    params.schedulingInputsRequested && !cronSchedulingInputsEqual(job, nextJob);

  if (params.scheduleChanged && nextJob.schedule.kind === "cron" && !isJobEnabled(nextJob)) {
    computeJobNextRunAtMs({ ...nextJob, enabled: true }, now);
  }

  nextJob.updatedAtMs = now;
  if (schedulingInputsChanged) {
    // Anchor restart catch-up to the new inputs. Without this, startup replays a
    // slot the previous schedule never had, because lastRunAtMs still belongs to
    // the old one and looks perpetually stale against the new slots (#91944).
    nextJob.state.scheduleActivatedAtMs = now;
    nextJob.state.startupCatchupAtMs = undefined;
    // A paced timestamp is owned by the exact schedule, pacing bounds, and
    // trigger mode that produced it. Configuration changes release both the
    // slot and its provenance so natural schedule math can take ownership.
    nextJob.state.pacedNextRunAtMs = undefined;
    nextJob.state.forcePreservedNextRunAtMs = undefined;
    if (isJobEnabled(nextJob)) {
      nextJob.state.nextRunAtMs = computeJobNextRunAtMs(nextJob, now);
    } else {
      nextJob.state.nextRunAtMs = undefined;
      nextJob.state.queuedAtMs = undefined;
      // Preserve only genuine execution. Queued reservations must clear so a
      // disabled job can accept a later force run with the same timestamp.
      if (!isCronJobActive(nextJob.id)) {
        Object.assign(nextJob.state, { runningAtMs: undefined, runningReceiptId: undefined });
        delete nextJob.state.runningScheduleChangeId;
      }
    }
  } else if (isJobEnabled(nextJob) && !hasScheduledNextRunAtMs(nextJob.state.nextRunAtMs)) {
    nextJob.state.nextRunAtMs = computeJobNextRunAtMs(nextJob, now);
  }
  if (nextJob.state.runningAtMs !== job.state.runningAtMs) {
    delete nextJob.state.runningReceiptId;
  }
}
