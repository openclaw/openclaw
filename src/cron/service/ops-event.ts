import {
  CronEventClaimInvalidatedError,
  MAX_CRON_EVENT_PAYLOAD_BYTES,
  MAX_CRON_EVENT_METADATA_BYTES,
  cronEventRunId,
  type CronEventAdmission,
  type CronEventRunOptions,
  type CronEventRunResult,
  type CronEventSourceSnapshot,
} from "../event-source.js";
import { cronSourceIdentity } from "../source-schedule.js";
import { isJobEnabled } from "./jobs-scheduling.js";
import { list } from "./ops-read.js";
import { enqueueRun } from "./ops-run.js";
import type { CronServiceState } from "./state.js";

/** Detached snapshots only; the service capability fixes source to its own plugin ID. */
export async function readEventSources(
  state: CronServiceState,
  source: string,
): Promise<CronEventSourceSnapshot[]> {
  const jobs = await list(state, { includeDisabled: true });
  return jobs.flatMap((job) =>
    job.schedule.kind === "event" && job.schedule.source === source && job.state.sourceIdentity
      ? [
          {
            jobId: job.id,
            sourceIdentity: job.state.sourceIdentity,
            // A global pause suspends admission, not this source incarnation.
            // Reporting it as disabled would revoke queued immutable events.
            enabled: isJobEnabled(job) && !job.state.autoDisabled,
            options: structuredClone(job.schedule.options),
          },
        ]
      : [],
  );
}

/** Transfer one immutable ingress claim, never queue a second copy of its event. */
export async function runEvent(
  state: CronServiceState,
  id: string,
  opts: CronEventRunOptions,
): Promise<CronEventRunResult> {
  // JSON snapshots use the ingress owner's serialization contract, not caller-owned objects.
  const input = {
    jobId: id,
    sourceIdentity: opts.sourceIdentity,
    eventId: opts.eventId,
    receivedAtMs: opts.receivedAtMs,
    payload: opts.payload,
  };
  const json = JSON.stringify(input);
  const payloadJson = JSON.stringify(input.payload);
  const metadataJson = JSON.stringify({ ...input, payload: undefined, claim: opts.claim });
  if (
    !input.sourceIdentity?.trim() ||
    !input.eventId?.trim() ||
    !Number.isSafeInteger(input.receivedAtMs) ||
    input.receivedAtMs < 0 ||
    payloadJson === undefined ||
    Buffer.byteLength(payloadJson, "utf8") > MAX_CRON_EVENT_PAYLOAD_BYTES ||
    Buffer.byteLength(metadataJson, "utf8") > MAX_CRON_EVENT_METADATA_BYTES ||
    !opts.claim.queueName ||
    !opts.claim.id ||
    !opts.claim.token
  ) {
    throw new Error("invalid or oversized automation event input");
  }
  const event: CronEventAdmission = { input: JSON.parse(json), claim: { ...opts.claim } };
  const runId = cronEventRunId(event);
  const generation = state.lifecycleGeneration;
  const transferred: { receiptId?: string } = {};
  const paused = new Error("automation event source is paused");
  const invalidated = new Error("automation event source is no longer current");
  const commitGuard = () => {
    if (
      state.stopped ||
      state.lifecycleGeneration !== generation ||
      !state.deps.cronEnabled ||
      state.schedulingPaused ||
      state.deps.cronConfig?.triggers?.enabled === false
    ) {
      throw paused;
    }
    const job = state.store?.jobs.find((candidate) => candidate.id === id);
    if (
      !job ||
      job.schedule.kind !== "event" ||
      !isJobEnabled(job) ||
      job.state.autoDisabled ||
      cronSourceIdentity(job) !== event.input.sourceIdentity
    ) {
      throw invalidated;
    }
    opts.commitGuard();
  };
  try {
    const execute = () =>
      enqueueRun(state, id, "if-enabled", {
        event,
        runId,
        commitGuard,
        onEventTransferred: (receipt) => {
          transferred.receiptId = receipt.receiptId;
        },
      });
    const result = await (state.deps.runSchedulerOwned
      ? state.deps.runSchedulerOwned(execute)
      : execute());
    if (transferred.receiptId) {
      return { kind: "transferred", receiptId: transferred.receiptId, runId };
    }
    if (result.ok && "reason" in result && result.reason === "already-running") {
      return { kind: "pending", reason: "busy" };
    }
    if (result.ok && "reason" in result && result.reason === "stopped") {
      return { kind: "pending", reason: "stopped" };
    }
    return { kind: "invalidated" };
  } catch (error) {
    // A committed activation is authoritative even if its local continuation fails.
    if (transferred.receiptId) {
      return { kind: "transferred", receiptId: transferred.receiptId, runId };
    }
    if (error === paused) {
      return {
        kind: "pending",
        reason: state.stopped || state.lifecycleGeneration !== generation ? "stopped" : "paused",
      };
    }
    if (error === invalidated || error instanceof CronEventClaimInvalidatedError) {
      return { kind: "invalidated" };
    }
    // Unknown writes retain their existing settlement owner; never replay them here.
    throw error;
  }
}
