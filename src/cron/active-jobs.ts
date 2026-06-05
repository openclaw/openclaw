/** Tracks in-process cron executions so schedulers and wake paths avoid duplicate runs. */
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type CronActiveJobState = {
  activeJobRuns: Map<string, Map<string, ActiveCronJobRun>>;
};

const CRON_ACTIVE_JOB_STATE_KEY = Symbol.for("openclaw.cron.activeJobs");
const DEFAULT_RUN_KEY = "__cron-job__";

type ActiveCronJobRun = {
  runId?: string;
  abortController?: AbortController;
};

type MarkCronJobActiveOptions = {
  runId?: string;
  abortController?: AbortController;
};

type CancelCronJobRunResult =
  | { found: false; cancelled: false; reason: string }
  | { found: true; cancelled: false; reason: string }
  | { found: true; cancelled: true };

function getCronActiveJobState(): CronActiveJobState {
  // Cron runs can cross module reload boundaries in tests and dev watch; keep
  // the in-flight job map process-global so duplicate-run guards share state.
  return resolveGlobalSingleton<CronActiveJobState>(CRON_ACTIVE_JOB_STATE_KEY, () => ({
    activeJobRuns: new Map<string, Map<string, ActiveCronJobRun>>(),
  }));
}

function normalizeRunKey(runId: string | undefined): string {
  return runId?.trim() || DEFAULT_RUN_KEY;
}

/** Marks a cron job id as currently executing for duplicate-run suppression. */
export function markCronJobActive(jobId: string, opts?: MarkCronJobActiveOptions) {
  if (!jobId) {
    return;
  }
  const state = getCronActiveJobState();
  const runs = state.activeJobRuns.get(jobId) ?? new Map<string, ActiveCronJobRun>();
  runs.set(normalizeRunKey(opts?.runId), {
    ...(opts?.runId ? { runId: opts.runId } : {}),
    ...(opts?.abortController ? { abortController: opts.abortController } : {}),
  });
  state.activeJobRuns.set(jobId, runs);
}

/** Clears the active marker when a cron run exits or is abandoned. */
export function clearCronJobActive(jobId: string, runId?: string) {
  if (!jobId) {
    return;
  }
  const state = getCronActiveJobState();
  if (runId === undefined) {
    state.activeJobRuns.delete(jobId);
    return;
  }
  const runs = state.activeJobRuns.get(jobId);
  if (!runs) {
    return;
  }
  runs.delete(normalizeRunKey(runId));
  if (runs.size === 0) {
    state.activeJobRuns.delete(jobId);
  }
}

/** Returns whether the given cron job id is currently executing in this process. */
export function isCronJobActive(jobId: string) {
  if (!jobId) {
    return false;
  }
  return (getCronActiveJobState().activeJobRuns.get(jobId)?.size ?? 0) > 0;
}

/** Returns whether any cron run is active in this process. */
export function hasActiveCronJobs() {
  return getCronActiveJobState().activeJobRuns.size > 0;
}

/** Aborts an active cron run in the current process when one owns the task row. */
export function cancelCronJobRun(params: {
  jobId?: string;
  runId?: string;
  reason?: string;
}): CancelCronJobRunResult {
  const jobId = params.jobId?.trim();
  if (!jobId) {
    return {
      found: false,
      cancelled: false,
      reason: "Cron task has no cancellable job id.",
    };
  }
  const runs = getCronActiveJobState().activeJobRuns.get(jobId);
  if (!runs || runs.size === 0) {
    return {
      found: false,
      cancelled: false,
      reason: "Cron task is not active in this gateway process.",
    };
  }
  let run: ActiveCronJobRun | undefined;
  if (params.runId) {
    run = runs.get(normalizeRunKey(params.runId));
  } else {
    const first = runs.values().next();
    run = first.done ? undefined : first.value;
  }
  if (!run) {
    return {
      found: false,
      cancelled: false,
      reason: "Cron task run is not active in this gateway process.",
    };
  }
  const controller = run.abortController;
  if (!controller) {
    return {
      found: true,
      cancelled: false,
      reason: "Cron task has no active cancellation handle.",
    };
  }
  if (controller.signal.aborted) {
    return {
      found: true,
      cancelled: false,
      reason: "Cron task is already cancelling.",
    };
  }
  controller.abort(params.reason?.trim() || "Cancelled by operator.");
  return {
    found: true,
    cancelled: true,
  };
}

/** Clears process-global cron active-job state between tests. */
export function resetCronActiveJobsForTests() {
  getCronActiveJobState().activeJobRuns.clear();
}
