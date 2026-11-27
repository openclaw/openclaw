import { MAX_CRON_CONCURRENT_RUNS } from "../../config/cron-limits.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import type { CronStoredJob } from "../types.js";
import { updateCronRuntimeRow } from "./row-codec.js";
import type { CronRunQueueOperations } from "./run-queue.types.js";
import { parseCronScheduledRunId } from "./run-request-id.js";

/** A condition check is the opening phase of a run; at most three runs are in that phase. */
export function isCheckingCondition(job: CronStoredJob): boolean {
  return (
    job.state.runningAtMs !== undefined &&
    job.state.conditionCheckReceiptId === job.state.runningReceiptId
  );
}

/**
 * A timed check holds no run slot: it is short and bounded, and run slots are for payloads.
 * A requested check keeps the slot it was activated with. So does a script payload's check,
 * whose time budget cannot pause while it waits for a slot.
 */
export function startsWithoutRunSlot(job: CronStoredJob, receiptId: string): boolean {
  return job.payload.kind !== "script" && parseCronScheduledRunId(receiptId) !== undefined;
}

/** A parked occurrence holds neither a condition-check slot nor a run slot. */
export function waitsForCronRunSlot(
  job: CronStoredJob | undefined,
  receiptId = job?.state.runningReceiptId,
): boolean {
  return (
    receiptId !== undefined &&
    job?.state.runningAtMs !== undefined &&
    job.state.runningReceiptId === receiptId &&
    job.state.runSlotWaitReceiptId === receiptId
  );
}

function activeRunSlots<T extends { receiptId: string; jobId: string }>(
  receipts: readonly T[],
  jobs: ReadonlyMap<string, CronStoredJob>,
): T[] {
  return receipts.filter((receipt) => {
    const job = jobs.get(receipt.jobId);
    return (
      job?.state.runningReceiptId === receipt.receiptId &&
      job.state.runningAtMs !== undefined &&
      !waitsForCronRunSlot(job, receipt.receiptId) &&
      !(isCheckingCondition(job) && startsWithoutRunSlot(job, receipt.receiptId))
    );
  });
}

/** Reconcile and allocate slots from the worker's current receipts in this drain transaction. */
export function createCronRunSlots(
  params: Pick<
    CronRunQueueOperations["cron.drainQueue"]["input"],
    "storeKey" | "maxConcurrentRuns" | "memoryAllowsExtraRun" | "providerBackoff"
  > & { db: EngineConnection },
  receipts: readonly { receiptId: string; jobId: string }[],
  jobs: ReadonlyMap<string, CronStoredJob>,
) {
  const active = activeRunSlots(receipts, jobs);
  let activeCount = active.length;
  // Once every base slot is busy, one more run may start per drain while memory is free, so each
  // later drain reads memory again with that run counted.
  let extraRunOpen = params.memoryAllowsExtraRun === true;
  const baseSlots = Math.max(1, params.maxConcurrentRuns);
  const extra: typeof active = [];
  const defaultReceiptIds = new Set<string>();
  for (const receipt of active) {
    if (jobs.get(receipt.jobId)?.state.extraRunSlotReceiptId === receipt.receiptId) {
      extra.push(receipt);
    } else {
      defaultReceiptIds.add(receipt.receiptId);
    }
  }
  // Fill freed default slots in activation order before applying provider allowances.
  const promotedReceiptIds = new Set<string>();
  for (const { jobId, receiptId } of extra.slice(
    0,
    Math.max(0, baseSlots - defaultReceiptIds.size),
  )) {
    const job = jobs.get(jobId)!;
    delete job.state.extraRunSlotReceiptId;
    updateCronRuntimeRow(params.db, params.storeKey, job);
    defaultReceiptIds.add(receiptId);
    promotedReceiptIds.add(receiptId);
  }
  const providerSlots = new Map(
    params.providerBackoff?.allowances.map(({ provider, slots }) => [provider, slots]),
  );
  for (const { receiptId, provider } of params.providerBackoff?.charges ?? []) {
    if (defaultReceiptIds.has(receiptId)) {
      // The worker can recover a committed promotion whose reply was lost.
      promotedReceiptIds.add(receiptId);
    } else if (provider !== undefined) {
      const slots = providerSlots.get(provider);
      if (slots !== undefined) {
        providerSlots.set(provider, slots - 1);
      }
    }
  }
  const hasRunSlot = (provider?: string) =>
    activeCount < baseSlots ||
    (extraRunOpen &&
      activeCount < MAX_CRON_CONCURRENT_RUNS &&
      (provider === undefined || (providerSlots.get(provider) ?? 1) > 0));
  const takeRunSlot = (job: CronStoredJob, receiptId: string) => {
    if (activeCount >= baseSlots) {
      job.state.extraRunSlotReceiptId = receiptId;
      extraRunOpen = false;
    } else {
      delete job.state.extraRunSlotReceiptId;
    }
    activeCount += 1;
  };
  return { hasRunSlot, takeRunSlot, promotedReceiptIds };
}
