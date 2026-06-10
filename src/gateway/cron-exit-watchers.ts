/**
 * Gateway-owned watchers for cron jobs with an `on-exit` schedule.
 *
 * The watcher process runs under the gateway ProcessSupervisor — NOT inside any
 * agent turn's process tree — so it survives the per-turn spawn-and-kill
 * teardown that CLI backends apply at turn end (#71662). When the watched
 * command exits, the job is fired via the origin-aware cron wake (`fireOnExit`),
 * so the woken turn continues the originating session/thread.
 *
 * v1 is one-shot per arm: a job fires once when its command exits and is not
 * re-armed (re-watching = re-add the job).
 */
import type { CronJob } from "../cron/types.js";
import type { ManagedRun, ProcessSupervisor } from "../process/supervisor/index.js";

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
  return job.enabled && job.schedule.kind === "on-exit";
}

export function createCronExitWatchers(params: {
  getProcessSupervisor: () => ProcessSupervisor;
  /**
   * Persist the one-shot job's terminal state (disable it) BEFORE firing, so a
   * gateway restart after the command exits cannot re-arm the watcher and
   * re-run the watched command (replaying arbitrary side effects).
   */
  persistCompletion: (jobId: string) => Promise<void>;
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
  // jobId -> watcher state. `armToken` identifies the current arm so an async
  // spawn/wait that loses ownership (the job was cancelled or re-armed for a
  // changed command) becomes a no-op. The slot is reserved synchronously in
  // arm() BEFORE the spawn awaits, so a concurrent cancel can act on an
  // in-flight spawn. `fired` marks one-shot completion.
  type WatcherSlot = {
    armToken: object;
    run: ManagedRun | undefined;
    fired: boolean;
    command: string;
    cwd: string | undefined;
  };
  const active = new Map<string, WatcherSlot>();

  const cancel = (jobId: string) => {
    const slot = active.get(jobId);
    if (!slot) {
      return;
    }
    active.delete(jobId);
    // Cancel an already-spawned child; an in-flight spawn (run undefined) is
    // killed by the arm() ownership check once it resolves.
    slot.run?.cancel("manual-cancel");
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
    const armToken: object = {};
    // Reserve the slot synchronously so a concurrent cancel/replace can observe
    // and act on this arm before the child is spawned.
    const slot: WatcherSlot = { armToken, run: undefined, fired: false, command, cwd };
    active.set(job.id, slot);
    const owns = () => active.get(job.id) === slot && slot.armToken === armToken;
    void (async () => {
      let run: ManagedRun;
      try {
        run = await params.getProcessSupervisor().spawn({
          sessionId: `cron-exit:${job.id}`,
          backendId: "cron-exit-watch",
          scopeKey: scopeKey(job.id),
          replaceExistingScope: true,
          mode: "child",
          argv: [shell.command, ...shell.argsFor(command)],
          ...(cwd ? { cwd } : {}),
          captureOutput: true,
        });
      } catch (err) {
        if (owns()) {
          active.delete(job.id);
        }
        params.logger.warn({ err: String(err), jobId: job.id }, "cron-exit: watcher spawn failed");
        return;
      }
      if (!owns()) {
        // Cancelled or re-armed (changed command/cwd) while the spawn was in
        // flight — kill this now-orphaned child instead of leaking it.
        run.cancel("manual-cancel");
        return;
      }
      slot.run = run;
      params.logger.info({ jobId: job.id, runId: run.runId, command }, "cron-exit: watcher armed");
      const exit = await run.wait();
      if (!owns()) {
        return;
      }
      params.logger.info(
        { jobId: job.id, exitCode: exit.exitCode, reason: exit.reason },
        "cron-exit: watched command exited; firing job",
      );
      // Persist the terminal one-shot state BEFORE firing. FAIL CLOSED: if the
      // store write fails we do NOT wake — waking without a persisted terminal
      // state would let a gateway restart re-arm and re-run the command.
      try {
        await params.persistCompletion(job.id);
      } catch (err) {
        params.logger.warn(
          { err: String(err), jobId: job.id },
          "cron-exit: persistCompletion failed; NOT firing (fail closed to avoid replay)",
        );
        return;
      }
      slot.fired = true;
      try {
        await params.fireOnExit(job, { exitCode: exit.exitCode });
      } catch (err) {
        params.logger.warn(
          { err: String(err), jobId: job.id },
          "cron-exit: fireOnExit after exit failed",
        );
      }
    })();
  };

  const reconcile = (jobs: CronJob[]) => {
    const want = new Map(jobs.filter(isWatchableExitJob).map((j) => [j.id, j] as const));
    // Cancel watchers whose job is gone or no longer watchable.
    for (const jobId of Array.from(active.keys())) {
      if (!want.has(jobId)) {
        cancel(jobId);
      }
    }
    for (const [jobId, job] of want) {
      const slot = active.get(jobId);
      if (slot) {
        // Already tracked. A fired one-shot stays put (re-watch = re-add). If
        // the watched command/cwd changed, cancel the stale watcher and re-arm.
        if (slot.fired) {
          continue;
        }
        const command = job.schedule.kind === "on-exit" ? job.schedule.command : undefined;
        const cwd = job.schedule.kind === "on-exit" ? job.schedule.cwd : undefined;
        if (slot.command === command && slot.cwd === cwd) {
          continue;
        }
        cancel(jobId);
      }
      arm(job);
    }
  };

  const cancelAll = () => {
    for (const jobId of Array.from(active.keys())) {
      cancel(jobId);
    }
  };

  return {
    reconcile,
    cancel,
    cancelAll,
    activeJobIds: () => Array.from(active.keys()),
  };
}
