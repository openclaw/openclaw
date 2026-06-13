/** Tracks in-process cron executions so schedulers and wake paths avoid duplicate runs. */
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type CronActiveJobCancel = (reason: string) => void;

type CronActiveJobEntry = {
  cancel?: CronActiveJobCancel;
  cancelRequestedReason?: string;
};

type CronActiveJobState = {
  activeJobIds: Set<string>;
  activeJobsById: Map<string, CronActiveJobEntry>;
};

const CRON_ACTIVE_JOB_STATE_KEY = Symbol.for("openclaw.cron.activeJobs");

function getCronActiveJobState(): CronActiveJobState {
  // Cron runs can cross module reload boundaries in tests and dev watch; keep
  // the in-flight job set process-global so duplicate-run guards share state.
  const state = resolveGlobalSingleton<CronActiveJobState>(CRON_ACTIVE_JOB_STATE_KEY, () => ({
    activeJobIds: new Set<string>(),
    activeJobsById: new Map<string, CronActiveJobEntry>(),
  }));
  state.activeJobsById ??= new Map<string, CronActiveJobEntry>();
  return state;
}

function upsertActiveJobEntry(
  jobId: string,
  update: (entry: CronActiveJobEntry) => CronActiveJobEntry,
): CronActiveJobEntry {
  const state = getCronActiveJobState();
  state.activeJobIds.add(jobId);
  const next = update(state.activeJobsById.get(jobId) ?? {});
  state.activeJobsById.set(jobId, next);
  return next;
}

function triggerPendingCancel(entry: CronActiveJobEntry) {
  if (!entry.cancel || !entry.cancelRequestedReason) {
    return;
  }
  entry.cancel(entry.cancelRequestedReason);
}

/** Marks a cron job id as currently executing for duplicate-run suppression. */
export function markCronJobActive(jobId: string, cancel?: CronActiveJobCancel) {
  if (!jobId) {
    return;
  }
  const entry = upsertActiveJobEntry(jobId, (current) => ({
    ...current,
    ...(cancel ? { cancel } : {}),
  }));
  triggerPendingCancel(entry);
}

/** Registers the abort hook for an already-active cron job. */
export function registerCronJobCancel(jobId: string, cancel: CronActiveJobCancel): () => void {
  if (!jobId) {
    return () => {};
  }
  const entry = upsertActiveJobEntry(jobId, (current) => ({
    ...current,
    cancel,
  }));
  triggerPendingCancel(entry);
  return () => {
    const state = getCronActiveJobState();
    const current = state.activeJobsById.get(jobId);
    if (current?.cancel === cancel) {
      const rest = { ...current };
      delete rest.cancel;
      state.activeJobsById.set(jobId, rest);
    }
  };
}

/** Clears the active marker when a cron run exits or is abandoned. */
export function clearCronJobActive(jobId: string) {
  if (!jobId) {
    return;
  }
  const state = getCronActiveJobState();
  state.activeJobIds.delete(jobId);
  state.activeJobsById.delete(jobId);
}

/** Returns whether the given cron job id is currently executing in this process. */
export function isCronJobActive(jobId: string) {
  if (!jobId) {
    return false;
  }
  return getCronActiveJobState().activeJobIds.has(jobId);
}

/** Returns whether any cron run is active in this process. */
export function hasActiveCronJobs() {
  return getCronActiveJobState().activeJobIds.size > 0;
}

/** Requests cancellation for an in-process cron run by job id. */
export function cancelCronJobActive(
  jobId: string,
  reason = "Cancelled by operator.",
): { found: boolean; cancelled: boolean; reason?: string } {
  if (!jobId) {
    return {
      found: false,
      cancelled: false,
      reason: "Cron task has no source job id.",
    };
  }
  const state = getCronActiveJobState();
  if (!state.activeJobIds.has(jobId)) {
    return {
      found: false,
      cancelled: false,
      reason: "Cron job is not running in this Gateway process.",
    };
  }
  const current = state.activeJobsById.get(jobId) ?? {};
  const entry = {
    ...current,
    cancelRequestedReason: reason,
  };
  state.activeJobsById.set(jobId, entry);
  triggerPendingCancel(entry);
  return {
    found: true,
    cancelled: true,
  };
}

/** Clears process-global cron active-job state between tests. */
export function resetCronActiveJobsForTests() {
  const state = getCronActiveJobState();
  state.activeJobIds.clear();
  state.activeJobsById.clear();
}
