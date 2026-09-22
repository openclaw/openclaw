import type { CronJob } from "../cron/types.js";
import { markOpenClawExecEnv } from "../infra/openclaw-exec-env.js";
import type { ManagedRun, ProcessSupervisor } from "../process/supervisor/index.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveExitWatchShell } from "./cron-exit-watch-shell.js";

/**
 * Safety bound for a watched command, so a hung/never-exiting command cannot
 * keep a gateway-owned process alive forever. Generous (24h) because on-exit
 * legitimately watches long-running commands (builds, deploys); on timeout the
 * watch ends and the job fires like any other exit.
 */
const ON_EXIT_WATCH_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const ON_EXIT_WATCH_RETRY_BACKOFF_MS = [1_000, 5_000, 30_000, 5 * 60_000] as const;

type Logger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

type OnExitCronJob = CronJob & { schedule: Extract<CronJob["schedule"], { kind: "on-exit" }> };

export type CronExitResult = {
  exitCode: number | null;
  reason: string;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  noOutputTimedOut: boolean;
};

export type CronExitWatcherHandlers = {
  getProcessSupervisor: () => ProcessSupervisor;
  fireOnExit: (
    job: OnExitCronJob,
    exit: CronExitResult,
    controls: {
      signal: AbortSignal;
      commitGuard: () => void;
      onTerminalWriteStarted: () => void;
      onReserved: () => void;
    },
  ) => Promise<void>;
  updateWatcherState?: (
    job: OnExitCronJob,
    patch: Pick<CronJob["state"], "lastError" | "consecutiveErrors">,
  ) => Promise<CronJob | void>;
  logger: Logger;
};

export type CronExitWatchers = {
  reconcile: (jobs: CronJob[]) => void;
  cancel: (jobId: string) => void;
  cancelAll: () => Promise<void>;
  activeJobIds: () => string[];
  updateHandlers: (handlers: CronExitWatcherHandlers) => Promise<void> | void;
};

const SCOPE_PREFIX = "cron-exit";

function scopeKey(jobId: string): string {
  return `${SCOPE_PREFIX}:${jobId}`;
}

function isWatchableExitJob(job: CronJob): job is OnExitCronJob {
  return job.enabled && job.schedule.kind === "on-exit";
}

export function createCronExitWatchers(
  params: CronExitWatcherHandlers & {
    shell?: { command: string; argsFor: (command: string) => string[] };
    retryBackoffMs?: readonly number[];
  },
): CronExitWatchers {
  let handlers: CronExitWatcherHandlers = params;
  const ownerSettlements = new Set<Promise<void>>();
  const settleOwnerCallback = async <T>(operation: Promise<T>): Promise<T> => {
    const settlement = operation.then(
      () => undefined,
      () => undefined,
    );
    ownerSettlements.add(settlement);
    try {
      return await operation;
    } finally {
      ownerSettlements.delete(settlement);
    }
  };
  const shell = params.shell ?? resolveExitWatchShell();
  const retryBackoffMs =
    params.retryBackoffMs && params.retryBackoffMs.length > 0
      ? params.retryBackoffMs
      : ON_EXIT_WATCH_RETRY_BACKOFF_MS;
  // jobId -> watcher state. `armToken` identifies the current arm so an async
  // spawn/wait that loses ownership (the job was cancelled or re-armed for a
  // changed command) becomes a no-op. The slot is reserved synchronously in
  // arm() BEFORE the spawn awaits, so a concurrent cancel can act on an
  // in-flight spawn. `fired` marks one-shot completion.
  type WatcherSlot = {
    armToken: object;
    job: OnExitCronJob;
    run: ManagedRun | undefined;
    fired: boolean;
    terminalPersisting: boolean;
    cancelled: boolean;
    admission: AbortController | undefined;
    lifecycleSettled: boolean;
    settlement: ReturnType<typeof createDeferredCore>;
    command: string;
    cwd: string | undefined;
    consecutiveFailures: number;
    retryTimer: NodeJS.Timeout | undefined;
  };
  const active = new Map<string, WatcherSlot>();
  // A cancelled child can keep running until the supervisor observes exit.
  // Retain those slots separately so replacement arms can own the job id while
  // suspension still sees every predecessor that is settling.
  const settlingCancelledSlots = new Set<WatcherSlot>();

  const cancel = (jobId: string, preserveReserved = false) => {
    const slots = new Set(
      Array.from(settlingCancelledSlots).filter((slot) => slot.job.id === jobId),
    );
    const current = active.get(jobId);
    if (current) {
      slots.add(current);
    }
    if (slots.size === 0) {
      return;
    }
    for (const slot of slots) {
      slot.cancelled = true;
      if (!preserveReserved || !slot.fired) {
        slot.admission?.abort();
      }
      if (slot.retryTimer) {
        clearTimeout(slot.retryTimer);
        slot.retryTimer = undefined;
      }
      if (!slot.lifecycleSettled) {
        settlingCancelledSlots.add(slot);
      }
      // Retain write-capable callbacks as suspension blockers through settlement.
      if (!slot.terminalPersisting && active.get(jobId) === slot) {
        active.delete(jobId);
      }
      slot.run?.cancel("manual-cancel");
    }
    try {
      handlers.getProcessSupervisor().cancelScope(scopeKey(jobId), "manual-cancel");
    } catch (err) {
      handlers.logger.warn({ err: String(err), jobId }, "cron-exit: cancel watcher failed");
    }
  };

  const arm = (job: OnExitCronJob, consecutiveFailures = 0) => {
    const command = job.schedule.command;
    const cwd = job.schedule.cwd;
    const armToken: object = {};
    const predecessors = Array.from(settlingCancelledSlots)
      .filter((previous) => previous.job.id === job.id)
      .map((previous) => previous.settlement.promise);
    // Reserve the slot synchronously so a concurrent cancel/replace can observe
    // and act on this arm before the child is spawned.
    const slot: WatcherSlot = {
      armToken,
      job,
      run: undefined,
      fired: false,
      terminalPersisting: false,
      cancelled: false,
      admission: undefined,
      lifecycleSettled: false,
      settlement: createDeferredCore(),
      command,
      cwd,
      consecutiveFailures,
      retryTimer: undefined,
    };
    active.set(job.id, slot);
    const owns = () => active.get(job.id) === slot && slot.armToken === armToken;
    const persistWatcherState = async (
      patch: Pick<CronJob["state"], "lastError" | "consecutiveErrors">,
    ) => {
      const owner = handlers;
      if (!owner.updateWatcherState) {
        return;
      }
      try {
        const updated = await settleOwnerCallback(owner.updateWatcherState(slot.job, patch));
        if (owns() && updated && isWatchableExitJob(updated)) {
          slot.job = updated;
        }
      } catch (err) {
        owner.logger.warn(
          { err: String(err), jobId: slot.job.id },
          "cron-exit: failed to persist watcher state",
        );
      }
    };
    const scheduleRetry = async (error: unknown, phase: "spawn" | "wait") => {
      if (!owns() || slot.cancelled) {
        return;
      }
      slot.consecutiveFailures += 1;
      const errorText = `${phase} failed: ${String(error)}`;
      await persistWatcherState({
        lastError: `cron on-exit watcher ${errorText}`,
        consecutiveErrors: slot.consecutiveFailures,
      });
      if (!owns() || slot.cancelled) {
        return;
      }
      const delayMs =
        retryBackoffMs[Math.min(slot.consecutiveFailures - 1, retryBackoffMs.length - 1)]!;
      slot.retryTimer = setTimeout(() => {
        slot.retryTimer = undefined;
        if (!owns() || slot.cancelled) {
          return;
        }
        active.delete(slot.job.id);
        arm(slot.job, slot.consecutiveFailures);
      }, delayMs);
      slot.retryTimer.unref?.();
      handlers.logger.warn(
        { err: String(error), jobId: slot.job.id, retryInMs: delayMs },
        `cron-exit: watcher ${phase} failed; retry scheduled`,
      );
    };
    void (async () => {
      let run: ManagedRun;
      try {
        run = await handlers.getProcessSupervisor().spawn({
          scopeKey: scopeKey(job.id),
          replaceExistingScope: true,
          mode: "child",
          argv: [shell.command, ...shell.argsFor(command)],
          ...(cwd ? { cwd } : {}),
          // Mark the child as an OpenClaw-launched subprocess (loop protection /
          // detection) and bound its lifetime — consistent with how cron
          // command-payload jobs run via runCommandWithTimeout.
          env: markOpenClawExecEnv({ ...process.env }),
          timeoutMs: ON_EXIT_WATCH_TIMEOUT_MS,
          captureOutput: true,
        });
      } catch (err) {
        // Keep the slot reserved as the retry placeholder; scheduleRetry re-arms
        // with backoff so a transient supervisor failure cannot silently drop
        // the watch (the job would otherwise never fire with no recorded cause).
        await scheduleRetry(err, "spawn");
        return;
      }
      if (!owns()) {
        // Cancelled or re-armed (changed command/cwd) while the spawn was in
        // flight — kill this now-orphaned child instead of leaking it. Wait for
        // supervisor settlement so suspension cannot snapshot a live child.
        run.cancel("manual-cancel");
        try {
          await run.wait();
        } catch {
          // The watcher was already cancelled; settlement, not outcome, matters.
        }
        return;
      }
      slot.run = run;
      handlers.logger.info(
        { jobId: job.id, runId: run.runId, command },
        "cron-exit: watcher armed",
      );
      let exit: Awaited<ReturnType<ManagedRun["wait"]>>;
      try {
        exit = await run.wait();
      } catch (err) {
        // run.wait() rejected (e.g. supervisor error) rather than resolving with
        // an exit. FAIL CLOSED: do not fire on an unknown outcome; scheduleRetry
        // re-arms the watch with backoff instead of dropping it silently.
        await scheduleRetry(err, "wait");
        return;
      }
      if (!owns()) {
        return;
      }
      if (predecessors.length > 0) {
        // Keep the exit pending until earlier payloads and their writes settle.
        await Promise.all(predecessors);
      }
      while (owns() && !slot.cancelled) {
        const owner = handlers;
        const admission = new AbortController();
        slot.admission = admission;
        try {
          await settleOwnerCallback(
            owner.fireOnExit(
              slot.job,
              {
                exitCode: exit.exitCode,
                reason: exit.reason,
                stdout: exit.stdout,
                stderr: exit.stderr,
                timedOut: exit.timedOut,
                noOutputTimedOut: exit.noOutputTimedOut,
              },
              {
                signal: admission.signal,
                commitGuard: () => {
                  if (admission.signal.aborted || (!slot.fired && (!owns() || slot.cancelled))) {
                    throw new Error("cron on-exit watcher no longer owns this exit");
                  }
                },
                onTerminalWriteStarted: () => {
                  slot.terminalPersisting = true;
                },
                onReserved: () => {
                  slot.fired = true;
                  slot.terminalPersisting = true;
                },
              },
            ),
          );
        } catch (err) {
          if (!owns() || slot.cancelled) {
            return;
          }
          if (owner !== handlers && !slot.fired) {
            continue;
          }
          active.delete(job.id);
          owner.logger.warn(
            { err: String(err), jobId: job.id },
            "cron-exit: fireOnExit after exit failed",
          );
        } finally {
          slot.admission = undefined;
          slot.terminalPersisting = false;
        }
        if (owner === handlers || slot.fired) {
          return;
        }
      }
    })().finally(() => {
      slot.lifecycleSettled = true;
      settlingCancelledSlots.delete(slot);
      if (slot.cancelled && active.get(job.id) === slot) {
        active.delete(job.id);
      }
      slot.settlement.resolve(undefined);
    });
  };

  const reconcile = (jobs: CronJob[]) => {
    const jobsById = new Map(jobs.map((job) => [job.id, job] as const));
    const want = new Map(jobs.filter(isWatchableExitJob).map((j) => [j.id, j] as const));
    // Cancel watchers whose job is gone or no longer watchable.
    for (const [jobId, slot] of Array.from(active.entries())) {
      if (!want.has(jobId)) {
        const storedJob = jobsById.get(jobId);
        // A replacement can observe the terminal disable before its previous
        // owner's completion callback has settled.
        if (
          slot.terminalPersisting &&
          storedJob?.schedule.kind === "on-exit" &&
          !storedJob.enabled &&
          slot.command === storedJob.schedule.command &&
          slot.cwd === storedJob.schedule.cwd
        ) {
          continue;
        }
        cancel(jobId);
      }
    }
    for (const [jobId, job] of want) {
      const slot = active.get(jobId);
      if (slot) {
        const { command, cwd } = job.schedule;
        // Completion persists disabled before firing, so an enabled job after
        // that point is a new arm, even while the previous payload is settling.
        if (!slot.fired && slot.command === command && slot.cwd === cwd) {
          slot.job = job;
          continue;
        }
        cancel(jobId, slot.fired && slot.command === command && slot.cwd === cwd);
      }
      arm(job);
    }
  };

  const cancelAll = async () => {
    const jobIds = new Set([
      ...active.keys(),
      ...Array.from(settlingCancelledSlots, (slot) => slot.job.id),
    ]);
    for (const jobId of jobIds) {
      cancel(jobId);
    }
    await Promise.all(Array.from(settlingCancelledSlots, (slot) => slot.settlement.promise));
  };

  return {
    reconcile,
    cancel,
    cancelAll,
    activeJobIds: () =>
      Array.from(
        new Set([
          ...Array.from(active.entries())
            .filter(([, slot]) => !slot.fired)
            .map(([jobId]) => jobId),
          ...Array.from(settlingCancelledSlots, (slot) => slot.job.id),
        ]),
      ),
    updateHandlers: (nextHandlers) => {
      if (handlers !== nextHandlers) {
        handlers = nextHandlers;
        // Rebind receipt admission to the new scheduler while existing
        // write-capable callbacks still drain through their captured owner.
        for (const slot of active.values()) {
          if (!slot.terminalPersisting) {
            slot.admission?.abort();
          }
        }
      }
      if (ownerSettlements.size > 0) {
        // Finish callbacks that already captured the old scheduler, but keep
        // live watched children running under their newly adopted owner.
        return Promise.all(ownerSettlements).then(() => undefined);
      }
      return undefined;
    },
  };
}
