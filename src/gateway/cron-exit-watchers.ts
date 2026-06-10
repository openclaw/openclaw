import type { CronJob } from "../cron/types.js";
/**
 * Gateway-owned watchers for cron jobs with an `on-exit` schedule.
 *
 * The watcher process runs under the gateway ProcessSupervisor — NOT inside any
 * agent turn's process tree — so it survives the per-turn spawn-and-kill
 * teardown that CLI backends apply at turn end (#71662). When the watched
 * command exits, the job is fired through the normal cron run pipeline
 * (`enqueueRun`), so delivery to the bound session is identical to a scheduled
 * main-session job.
 *
 * v1 is one-shot per arm: a job fires once when its command exits and is not
 * re-armed (re-watching = re-add the job). Exit-code/output folding into the
 * event text is a planned enhancement.
 */
import type { ProcessSupervisor } from "../process/supervisor/index.js";

type Logger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

export type CronExitWatchers = {
  /** Arm watchers for enabled on-exit jobs; cancel watchers for jobs that are gone/disabled. */
  reconcile: (jobs: CronJob[]) => void;
  /** Cancel a single job's watcher (e.g. on removal). */
  cancel: (jobId: string) => void;
  /** Cancel all watchers (gateway shutdown). */
  cancelAll: () => void;
  /** Test/diagnostic: ids with a live watcher. */
  activeJobIds: () => string[];
};

const SCOPE_PREFIX = "cron-exit";

function scopeKey(jobId: string): string {
  return `${SCOPE_PREFIX}:${jobId}`;
}

/** True when a job should currently have a live exit-watcher. */
function isWatchableExitJob(job: CronJob): boolean {
  return job.enabled !== false && job.schedule.kind === "on-exit";
}

export function createCronExitWatchers(params: {
  getProcessSupervisor: () => ProcessSupervisor;
  /**
   * Fire the job when its watched command exits. The caller routes this to the
   * origin-aware cron wake (continuing the originating session/thread), with the
   * exit code available to compose the woken turn's text.
   */
  fireOnExit: (job: CronJob, exit: { exitCode: number | null }) => void | Promise<void>;
  logger: Logger;
  /** Shell used to run the watched command (default: bash -lc). */
  shell?: { command: string; argsFor: (command: string) => string[] };
}): CronExitWatchers {
  const shell = params.shell ?? {
    command: "bash",
    argsFor: (command: string) => ["-lc", command],
  };
  // jobId -> watcher state. `fired` marks one-shot completion so reconcile does
  // not re-arm a job whose command already exited.
  const active = new Map<string, { runId: string; fired: boolean }>();

  const cancel = (jobId: string) => {
    if (!active.has(jobId)) {
      return;
    }
    active.delete(jobId);
    try {
      params.getProcessSupervisor().cancelScope(scopeKey(jobId), "manual-cancel");
    } catch (err) {
      params.logger.warn({ err: String(err), jobId }, "cron-exit: cancel watcher failed");
    }
  };

  const arm = (job: CronJob) => {
    if (job.schedule.kind !== "on-exit") {
      return;
    }
    const command = job.schedule.command;
    const cwd = job.schedule.cwd;
    void (async () => {
      try {
        const run = await params.getProcessSupervisor().spawn({
          sessionId: `cron-exit:${job.id}`,
          backendId: "cron-exit-watch",
          scopeKey: scopeKey(job.id),
          replaceExistingScope: true,
          mode: "child",
          argv: [shell.command, ...shell.argsFor(command)],
          ...(cwd ? { cwd } : {}),
          captureOutput: true,
        });
        active.set(job.id, { runId: run.runId, fired: false });
        params.logger.info(
          { jobId: job.id, runId: run.runId, command },
          "cron-exit: watcher armed",
        );
        const exit = await run.wait();
        const state = active.get(job.id);
        // If the watcher was cancelled (operator removed/disabled the job) the
        // map entry is gone or replaced — do not fire a stale job.
        if (!state || state.runId !== run.runId) {
          return;
        }
        state.fired = true;
        params.logger.info(
          { jobId: job.id, exitCode: exit.exitCode, reason: exit.reason },
          "cron-exit: watched command exited; firing job",
        );
        try {
          await params.fireOnExit(job, { exitCode: exit.exitCode });
        } catch (err) {
          params.logger.warn(
            { err: String(err), jobId: job.id },
            "cron-exit: fireOnExit after exit failed",
          );
        }
      } catch (err) {
        active.delete(job.id);
        params.logger.warn({ err: String(err), jobId: job.id }, "cron-exit: watcher spawn failed");
      }
    })();
  };

  const reconcile = (jobs: CronJob[]) => {
    const want = new Map(jobs.filter(isWatchableExitJob).map((j) => [j.id, j] as const));
    // Cancel watchers whose job is gone or no longer watchable.
    for (const jobId of [...active.keys()]) {
      if (!want.has(jobId)) {
        cancel(jobId);
      }
    }
    // Arm watchers for newly-watchable jobs. Skip any job already tracked —
    // whether still armed or already fired (one-shot; re-watch = re-add).
    for (const [jobId, job] of want) {
      if (active.has(jobId)) {
        continue;
      }
      arm(job);
    }
  };

  const cancelAll = () => {
    for (const jobId of [...active.keys()]) {
      cancel(jobId);
    }
  };

  return {
    reconcile,
    cancel,
    cancelAll,
    activeJobIds: () => [...active.keys()],
  };
}
