import { runInDetachedAsyncContext } from "../../shared/async-work-scope.js";
import type { CronRunReceiptRecoveryCandidate } from "../store/run-receipt-store.js";
import type { CronServiceState } from "./state.js";

// Lifecycle-owned freshness exception: only the bounded active foreign-receipt
// set is rechecked, every two seconds, until exact receipt identity retires.
const CRON_FOREIGN_RECEIPT_RECHECK_MS = 2_000;
type Monitor = {
  byJobId: Map<string, CronRunReceiptRecoveryCandidate>;
  waiters: Map<string, Set<(settled: boolean) => void>>;
  reconcile?: () => Promise<void>;
  timer: NodeJS.Timeout | null;
};
const monitors = new WeakMap<CronServiceState, Monitor>();

function monitor(state: CronServiceState): Monitor {
  let current = monitors.get(state);
  if (!current) {
    current = { byJobId: new Map(), waiters: new Map(), timer: null };
    monitors.set(state, current);
  }
  return current;
}

function arm(state: CronServiceState): void {
  const current = monitor(state);
  const reconcile = current.reconcile;
  if (state.stopped || current.timer || current.byJobId.size === 0 || !reconcile) {
    return;
  }
  current.timer = setTimeout(() => {
    runInDetachedAsyncContext(() => {
      current.timer = null;
      const work = state.deps.runSchedulerOwned
        ? state.deps.runSchedulerOwned(reconcile)
        : reconcile();
      void work
        .catch((error: unknown) => {
          state.deps.log.warn(
            { err: String(error) },
            "cron: foreign receipt reconciliation failed",
          );
        })
        .finally(() => arm(state));
    });
  }, CRON_FOREIGN_RECEIPT_RECHECK_MS);
  current.timer.unref?.();
}

export function configureForeignReceiptMonitor(
  state: CronServiceState,
  reconcile: () => Promise<void>,
): void {
  monitor(state).reconcile = reconcile;
  arm(state);
}

export function enrollForeignReceipt(
  state: CronServiceState,
  receipt: CronRunReceiptRecoveryCandidate,
): void {
  monitor(state).byJobId.set(receipt.jobId, receipt);
  arm(state);
}

export function listForeignReceipts(state: CronServiceState): CronRunReceiptRecoveryCandidate[] {
  return [...monitor(state).byJobId.values()].toSorted((left, right) =>
    left.jobId.localeCompare(right.jobId),
  );
}

export function waitForForeignReceipt(
  state: CronServiceState,
  jobId: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (state.stopped || signal.aborted) {
    return Promise.resolve(false);
  }
  const current = monitor(state);
  if (!current.byJobId.has(jobId)) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const waiters = current.waiters.get(jobId) ?? new Set<(settled: boolean) => void>();
    const finish = (settled: boolean) => {
      signal.removeEventListener("abort", abort);
      waiters.delete(finish);
      if (waiters.size === 0) {
        current.waiters.delete(jobId);
      }
      resolve(settled);
    };
    const abort = () => finish(false);
    waiters.add(finish);
    current.waiters.set(jobId, waiters);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
  });
}

export function removeForeignReceipt(state: CronServiceState, jobId: string): void {
  const current = monitor(state);
  current.byJobId.delete(jobId);
  for (const finish of current.waiters.get(jobId) ?? []) {
    finish(true);
  }
}

export function stopForeignReceiptMonitor(state: CronServiceState): void {
  const current = monitor(state);
  if (current.timer) {
    clearTimeout(current.timer);
    current.timer = null;
  }
  current.byJobId.clear();
  current.reconcile = undefined;
  for (const waiters of current.waiters.values()) {
    for (const finish of waiters) {
      finish(false);
    }
  }
}

export function resumeForeignReceiptMonitor(state: CronServiceState): void {
  arm(state);
}
