import { AsyncLocalStorage } from "node:async_hooks";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { AsyncWorkScope, runOutsideAsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";

export type GatewaySchedulerClock = {
  now: () => number;
  monotonicNow: () => number;
  arm: (run: () => void | Promise<void>, delayMs: number) => () => void;
};

export type GatewayScheduledJob = {
  cancel: () => void;
  stop: () => Promise<void>;
};

type ScheduleParams = {
  id: string;
  everyMs?: number;
  /** Keep both pending clock deadlines when a stale read would postpone the wake. */
  mode?: "replace" | "earliest";
  run: () => void | Promise<unknown>;
} & ({ atMs: number } | { delayMs: number });

export type GatewaySchedulerScope = Pick<
  GatewayScheduler,
  "signal" | "now" | "schedule" | "beginClose" | "stop"
> & {
  /** Preserve synchronous retirement when this owner has no running work. */
  close: () => Promise<void> | undefined;
};

type ScheduleOwner = {
  signal: AbortSignal;
  jobs: Set<ScheduledWork>;
};

type ScheduledWork = {
  id: string;
  atMs: number;
  elapsedAtMs?: number;
  everyMs?: number;
  run: () => void | Promise<unknown>;
  context: ReturnType<typeof AsyncLocalStorage.snapshot>;
  running?: Promise<void>;
  cancelled: boolean;
  owner?: ScheduleOwner;
};

const log = createSubsystemLogger("gateway/scheduler");
const hostClock: GatewaySchedulerClock = {
  now: () => Date.now(),
  monotonicNow: () => performance.now(),
  arm: (run, delayMs) => {
    // Host callbacks stay synchronous; execution joins belong to the scheduler.
    const timer = setTimeout(() => {
      void run();
    }, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

/** Owns Gateway wakeups; stores and execution owners retain their deadlines and authority. */
export class GatewayScheduler {
  private readonly clock: GatewaySchedulerClock;
  private readonly jobs = new Map<string, ScheduledWork>();
  private readonly pending = new Set<Promise<void>>();
  private cancelTimer?: () => void;
  private dispatching = false;
  private timerGeneration = 0;
  private readonly controller = new AbortController();

  constructor(
    options: {
      clock?: GatewaySchedulerClock;
    } = {},
  ) {
    this.clock = options.clock ?? hostClock;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  now(): number {
    return this.clock.now();
  }

  get nextWakeAtMs(): number | null {
    const nowMs = this.now();
    const elapsedMs = this.clock.monotonicNow();
    let next: number | null = null;
    for (const job of this.jobs.values()) {
      if (job.running) {
        continue;
      }
      const atMs = nowMs + this.remaining(job, nowMs, elapsedMs);
      next = next === null ? atMs : Math.min(next, atMs);
    }
    return next;
  }

  /** Closes one owner's timers without retiring siblings or losing in-flight joins. */
  scope(): GatewaySchedulerScope {
    const controller = new AbortController();
    const owner: ScheduleOwner = {
      signal: AbortSignal.any([this.signal, controller.signal]),
      jobs: new Set(),
    };
    const beginClose = () => {
      controller.abort();
      for (const job of owner.jobs) {
        this.cancel(job);
      }
    };
    const close = () => {
      beginClose();
      const running = [...owner.jobs].flatMap((job) => job.running ?? []);
      return running.length > 0 ? Promise.all(running).then(() => undefined) : undefined;
    };
    return {
      signal: owner.signal,
      now: () => this.now(),
      schedule: (params) => this.scheduleOwned(params, owner),
      beginClose,
      close,
      stop: async () => {
        await close();
      },
    };
  }

  schedule(params: ScheduleParams): GatewayScheduledJob {
    return this.scheduleOwned(params);
  }

  private scheduleOwned(params: ScheduleParams, owner?: ScheduleOwner): GatewayScheduledJob {
    const relative = "delayMs" in params;
    const nowMs = this.now();
    const atMs = relative ? nowMs + params.delayMs : params.atMs;
    if (
      !Number.isFinite(atMs) ||
      (params.everyMs !== undefined && (!Number.isFinite(params.everyMs) || params.everyMs <= 0))
    ) {
      throw new Error(`Invalid Gateway schedule: ${params.id}`);
    }
    const cancelled = this.signal.aborted || owner?.signal.aborted === true;
    const previous = cancelled ? undefined : this.jobs.get(params.id);
    const job: ScheduledWork = {
      id: params.id,
      run: params.run,
      everyMs: params.everyMs,
      atMs,
      elapsedAtMs:
        relative || params.everyMs !== undefined
          ? this.clock.monotonicNow() + Math.max(0, atMs - nowMs)
          : undefined,
      context: runOutsideAsyncWorkScope(() => AsyncLocalStorage.snapshot()),
      cancelled,
      owner,
    };
    if (params.mode === "earliest" && previous && !previous.running) {
      job.atMs = Math.min(job.atMs, previous.atMs);
      if (previous.elapsedAtMs !== undefined) {
        job.elapsedAtMs =
          job.elapsedAtMs === undefined
            ? previous.elapsedAtMs
            : Math.min(job.elapsedAtMs, previous.elapsedAtMs);
      }
    }
    const cancel = () => this.cancel(job);
    if (!cancelled) {
      owner?.jobs.add(job);
      this.jobs.set(job.id, job);
      if (previous) {
        this.cancel(previous);
      }
      this.arm();
    }
    return {
      cancel,
      stop: async () => {
        cancel();
        await job.running;
      },
    };
  }

  private cancel(job: ScheduledWork): void {
    job.cancelled = true;
    if (!job.running) {
      job.owner?.jobs.delete(job);
    }
    if (this.jobs.get(job.id) === job) {
      this.jobs.delete(job.id);
      this.arm();
    }
  }

  beginClose(): void {
    this.controller.abort();
    this.timerGeneration += 1;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    for (const job of this.jobs.values()) {
      this.cancel(job);
    }
    this.jobs.clear();
  }

  async stop(): Promise<void> {
    this.beginClose();
    await Promise.all(this.pending);
  }

  private remaining(job: ScheduledWork, nowMs: number, elapsedMs: number): number {
    const wallDelay = job.atMs - nowMs;
    // Wall time catches sleep on hosts whose monotonic clock pauses; elapsed time
    // keeps cadences moving through backward wall-clock corrections.
    return job.elapsedAtMs === undefined
      ? wallDelay
      : Math.min(wallDelay, job.elapsedAtMs - elapsedMs);
  }

  private arm(): void {
    if (this.signal.aborted || this.dispatching) {
      return;
    }
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    const generation = ++this.timerGeneration;
    const next = this.nextWakeAtMs;
    if (next !== null) {
      const nowMs = this.now();
      // Node clamps larger delays to 1ms. Long deadlines retain their absolute due time.
      const delayMs = Math.min(2_147_483_647, Math.max(0, next - nowMs));
      this.cancelTimer = this.clock.arm(
        () => (generation === this.timerGeneration ? this.wake(nowMs + delayMs) : undefined),
        delayMs,
      );
    }
  }

  private wake(expectedAtMs: number): Promise<void> | void {
    this.cancelTimer = undefined;
    if (this.signal.aborted) {
      return;
    }
    const nowMs = this.now();
    const elapsedMs = this.clock.monotonicNow();
    const due = [...this.jobs.values()]
      .filter((job) => !job.running && this.remaining(job, nowMs, elapsedMs) <= 0)
      .toSorted(
        (a, b) => this.remaining(a, nowMs, elapsedMs) - this.remaining(b, nowMs, elapsedMs),
      );
    const started: Promise<void>[] = [];
    if (nowMs - expectedAtMs > 60_000) {
      log.debug(`late wake by ${nowMs - expectedAtMs}ms; coalescing ${due.length} due jobs`);
    }
    this.dispatching = true;
    try {
      for (const job of due) {
        if (
          this.signal.aborted ||
          job.cancelled ||
          job.owner?.signal.aborted ||
          this.jobs.get(job.id) !== job
        ) {
          continue;
        }
        if (job.everyMs === undefined) {
          this.jobs.delete(job.id);
        }
        started.push(this.run(job));
      }
    } finally {
      this.dispatching = false;
      this.arm();
    }
    return Promise.all(started).then(() => undefined);
  }

  private run(job: ScheduledWork): Promise<void> {
    // Cadence jobs can run every few milliseconds (event-loop sampling runs every 20ms),
    // so only one-shot runs are worth a debug line.
    if (job.everyMs === undefined) {
      log.debug(`running ${job.id}`);
    } else {
      log.trace(`running ${job.id}`);
    }
    const done = createDeferredCore();
    const work = new AsyncWorkScope();
    job.running = done.promise;
    this.pending.add(done.promise);
    const finish = () => {
      job.running = undefined;
      this.pending.delete(done.promise);
      // Coalesce all missed periods, including time spent in the callback, into this one run.
      if (job.everyMs !== undefined && !job.cancelled && !this.signal.aborted) {
        job.atMs = this.now() + job.everyMs;
        job.elapsedAtMs = this.clock.monotonicNow() + job.everyMs;
      } else {
        job.owner?.jobs.delete(job);
      }
      done.resolve();
      this.arm();
    };
    let result: void | Promise<unknown> = undefined;
    try {
      result = job.context(() => work.run(job.run));
    } catch (error) {
      log.error(`${job.id} failed: ${String(error)}`);
    }
    if (!result && !work.hasPendingWork) {
      finish();
      return done.promise;
    }
    void Promise.resolve(result)
      .catch((error: unknown) => log.error(`${job.id} failed: ${String(error)}`))
      .then(() =>
        AsyncWorkScope.runWhenAllIdle(
          () => [work],
          () => work.drain(),
        ),
      )
      .finally(finish);
    return done.promise;
  }
}
