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

type ScheduledWork = {
  id: string;
  atMs: number;
  elapsedAtMs?: number;
  everyMs?: number;
  run: () => void | Promise<unknown>;
  context: ReturnType<typeof AsyncLocalStorage.snapshot>;
  pending: Set<Promise<void>>;
  cancelled: boolean;
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
  private closed = false;
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
      if (job.pending.size > 0) {
        continue;
      }
      const atMs = nowMs + this.remaining(job, nowMs, elapsedMs);
      next = next === null ? atMs : Math.min(next, atMs);
    }
    return next;
  }

  schedule(
    params: {
      id: string;
      everyMs?: number;
      /** Keep both pending clock deadlines when a stale read would postpone the wake. */
      mode?: "replace" | "earliest";
      run: () => void | Promise<unknown>;
    } & ({ atMs: number } | { delayMs: number }),
  ): GatewayScheduledJob {
    const relative = "delayMs" in params;
    const nowMs = this.now();
    const atMs = relative ? nowMs + params.delayMs : params.atMs;
    if (
      !Number.isFinite(atMs) ||
      (params.everyMs !== undefined && (!Number.isFinite(params.everyMs) || params.everyMs <= 0))
    ) {
      throw new Error(`Invalid Gateway schedule: ${params.id}`);
    }
    const previous = this.jobs.get(params.id);
    if (previous) {
      previous.cancelled = true;
    }
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
      pending: new Set(),
      cancelled: this.closed,
    };
    if (params.mode === "earliest" && previous && previous.pending.size === 0) {
      job.atMs = Math.min(job.atMs, previous.atMs);
      if (previous.elapsedAtMs !== undefined) {
        job.elapsedAtMs =
          job.elapsedAtMs === undefined
            ? previous.elapsedAtMs
            : Math.min(job.elapsedAtMs, previous.elapsedAtMs);
      }
    }
    const cancel = () => {
      job.cancelled = true;
      if (this.jobs.get(job.id) === job) {
        this.jobs.delete(job.id);
        this.arm();
      }
    };
    if (!this.closed) {
      this.jobs.set(job.id, job);
      this.arm();
    }
    return {
      cancel,
      stop: async () => {
        cancel();
        await Promise.all(job.pending);
      },
    };
  }

  beginClose(): void {
    this.closed = true;
    this.controller.abort();
    this.timerGeneration += 1;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    for (const job of this.jobs.values()) {
      job.cancelled = true;
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
    if (this.closed || this.dispatching) {
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
    if (this.closed) {
      return;
    }
    const nowMs = this.now();
    const elapsedMs = this.clock.monotonicNow();
    const due = [...this.jobs.values()]
      .filter((job) => job.pending.size === 0 && this.remaining(job, nowMs, elapsedMs) <= 0)
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
        if (this.closed || job.cancelled || this.jobs.get(job.id) !== job) {
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
    log.debug(`running ${job.id}`);
    const done = createDeferredCore();
    const work = new AsyncWorkScope();
    job.pending.add(done.promise);
    this.pending.add(done.promise);
    const finish = () => {
      job.pending.delete(done.promise);
      this.pending.delete(done.promise);
      // Coalesce all missed periods, including time spent in the callback, into this one run.
      if (job.everyMs !== undefined && !job.cancelled && !this.closed) {
        job.atMs = this.now() + job.everyMs;
        job.elapsedAtMs = this.clock.monotonicNow() + job.everyMs;
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
