import { randomUUID } from "node:crypto";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import type {
  CronQueuedRun,
  CronRunQueueOperations,
  CronRunRequestContext,
} from "../store/run-queue.types.js";
import type { CronJob } from "../types.js";
import type { ManualRunOptions } from "./run-options.js";
import { isImmediateCronRunMode, type CronRunMode } from "./state.js";

export type CronRunOptions = ManualRunOptions & {
  mode?: CronRunMode;
  source?: "scheduled" | "startup" | "manual" | "event";
};

/** Encode worker requests without owning admission, publication, or launch state. */
export function createCronRunRequests(
  candidates: readonly CronJob[],
  options: CronRunOptions,
  nowMs: number,
): CronRunQueueOperations["cron.requestRuns"]["input"]["requests"] {
  return candidates.map((job) => {
    // A released claim may be retried with a new token, but keeps its public event run ID.
    const receiptId = (options.event ? undefined : options.runId) ?? `cron-request.${randomUUID()}`;
    return {
      receiptId,
      jobId: job.id,
      configRevision: resolveCronJobConfigRevision(job),
      mode: options.onExit
        ? ("on-exit" as const)
        : options.mode === "force"
          ? ("force" as const)
          : ("if-enabled" as const),
      onExitSchedule: options.onExit?.schedule,
      event: options.event,
      preserveSchedule: isImmediateCronRunMode(options.mode),
      scheduleOwnershipAtMs: options.scheduleOwnershipAtMs ?? nowMs,
      requestRunId: options.runId ?? receiptId,
    };
  });
}

/** Project only transient fields needed by the worker; launch state stays with the queue owner. */
export function projectCronRunQueueRequests(
  contexts: Iterable<{
    receipt: CronQueuedRun["runReceipt"];
    options: CronRunOptions;
    started?: boolean;
    eventTransferred?: boolean;
  }>,
  selection: { includePendingEvents?: boolean } = {},
): CronRunRequestContext[] {
  return (
    [...contexts]
      // Scheduler commands lack plugin admission; only the guarded drain may transfer events.
      .filter(
        (pending) =>
          !pending.started &&
          (selection.includePendingEvents || !pending.options.event || pending.eventTransferred),
      )
      .map(({ receipt, options, eventTransferred }) => ({
        receiptId: receipt.receiptId,
        mode: options.onExit
          ? "on-exit"
          : options.source === "manual" || options.source === "event"
            ? options.mode === "force"
              ? "force"
              : "if-enabled"
            : "scheduled",
        onExitSchedule: options.onExit?.schedule,
        event: eventTransferred ? undefined : options.event,
      }))
  );
}
