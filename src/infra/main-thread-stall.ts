import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { versions } from "node:process";
import { promiseHooks } from "node:v8";
import { runWithAsyncStore } from "../shared/async-store.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const STALL_MS = 250;
const UNATTRIBUTED_STALL_MS = 1_000;
const HEARTBEAT_MS = 20;
const MAX_PENDING_STALLS = 8;

type TaskObserver = {
  run<T>(name: string, run: () => T, phase?: string): T;
  currentName(): string | undefined;
  stop(): void;
};
type MainThreadTaskState = { observer?: TaskObserver; context: AsyncLocalStorage<string> };

const taskState = resolveGlobalSingleton<MainThreadTaskState>(
  Symbol.for("openclaw.mainThreadTask"),
  () => ({ context: new AsyncLocalStorage<string>() }),
);

/** Synchronous callers can enter a stored owner context without losing their enclosing task. */
export function getMainThreadTaskName(): string | undefined {
  return taskState.observer?.currentName() ?? taskState.context.getStore();
}

/**
 * Name code-owned work only; request text, paths, and identifiers do not belong in labels.
 * Phases label synchronous segments; only task boundaries establish an inherited async name.
 */
export function runWithMainThreadTask<T>(name: string, run: () => T, phase?: string): T {
  const observer = taskState.observer;
  return observer ? observer.run(name, run, phase) : run();
}

/** Measure explicit synchronous scopes; unscoped stalls rely on best-effort loop sampling. */
export function createMainThreadStallMonitor(now: () => number = () => performance.now()) {
  taskState.observer?.stop();
  const pending: {
    elapsedMs: number;
    task: string;
    taskMs: number;
    startedAt: number;
    endedAt: number;
  }[] = [];
  let heartbeat: NodeJS.Timeout | undefined;
  // Closure slots box fractional timestamps on every continuation; reuse unboxed storage.
  // Every index below is a fixed slot in this never-resized buffer.
  const timing = new Float64Array(5);
  const heartbeatAt = 0,
    delayMaxMs = 1,
    startedAt = 2,
    segmentAt = 3,
    longestMs = 4;
  timing[heartbeatAt] = now();
  let dropped = 0;
  let unattributedDropped = 0;
  let active = false;
  let task = "unattributed";
  let phase: string | undefined;
  let longestTask = task;
  let longestPhase: string | undefined;
  let resumedPromise: Promise<unknown> | undefined;
  let stopContinuations: (() => void) | undefined;
  const observeLoop = () => {
    const at = now();
    const from = timing[heartbeatAt]!;
    timing[heartbeatAt] = at;
    const elapsedMs = at - from;
    if (
      elapsedMs <= UNATTRIBUTED_STALL_MS ||
      pending.some(
        (stall) => stall.startedAt <= from + HEARTBEAT_MS && stall.endedAt >= at - HEARTBEAT_MS,
      )
    ) {
      return;
    }
    if (pending.length < MAX_PENDING_STALLS) {
      pending.push({
        elapsedMs,
        task: "unattributed",
        taskMs: elapsedMs,
        startedAt: from,
        endedAt: at,
      });
    } else {
      unattributedDropped++;
    }
  };
  const segment = (at: number) => {
    const elapsed = at - timing[segmentAt]!;
    if (elapsed > timing[longestMs]!) {
      longestTask = task;
      longestPhase = phase;
      timing[longestMs] = elapsed;
    }
    timing[segmentAt] = at;
  };
  const begin = (name: string, at: number) => {
    active = true;
    timing[startedAt] = timing[segmentAt] = at;
    task = longestTask = name;
    phase = longestPhase = undefined;
    timing[longestMs] = 0;
  };
  const finish = (at: number) => {
    active = false;
    const elapsedMs = at - timing[startedAt]!;
    timing[delayMaxMs] = Math.max(timing[delayMaxMs]!, elapsedMs);
    if (elapsedMs >= STALL_MS) {
      if (pending.length < MAX_PENDING_STALLS) {
        pending.push({
          elapsedMs,
          task: longestPhase ? `${longestTask}:${longestPhase}` : longestTask,
          taskMs: timing[longestMs]!,
          startedAt: timing[startedAt]!,
          endedAt: at,
        });
      } else {
        dropped++;
      }
    }
  };
  // Observe await continuations in their inherited context, never in the heartbeat.
  // V8 hooks avoid async-id bookkeeping; retain only the executing Promise.
  const continuations = {
    before(promise: Promise<unknown>) {
      const name = taskState.context.getStore();
      if (!active && name !== undefined) {
        resumedPromise = promise;
        begin(name, now());
      }
    },
    after(promise: Promise<unknown>) {
      if (resumedPromise === promise) {
        resumedPromise = undefined;
        const at = now();
        segment(at);
        finish(at);
      }
    },
  };
  const observer: TaskObserver = {
    currentName: () => (active ? task : undefined),
    stop() {
      clearInterval(heartbeat);
      heartbeat = undefined;
      stopContinuations?.();
      stopContinuations = undefined;
      resumedPromise = undefined;
      if (taskState.observer === observer) {
        delete taskState.observer;
        taskState.context.disable();
      }
      pending.length = 0;
      dropped = 0;
      unattributedDropped = 0;
      timing[delayMaxMs] = 0;
    },
    run(name, run, taskPhase) {
      const enteredAt = now();
      const ownsTurn = !active;
      if (ownsTurn) {
        begin("unattributed", enteredAt);
      } else {
        segment(enteredAt);
      }
      const previous = task;
      const previousPhase = phase;
      task = name;
      phase = taskPhase;
      try {
        return taskPhase === undefined ? runWithAsyncStore(taskState.context, name, run) : run();
      } finally {
        const at = now();
        segment(at);
        task = previous;
        phase = previousPhase;
        if (ownsTurn) {
          finish(at);
        }
      }
    },
  };
  taskState.observer = observer;
  return {
    setEventLoopSampling(enabled: boolean) {
      if (enabled === Boolean(heartbeat)) {
        return;
      }
      clearInterval(heartbeat);
      // Use a raw heartbeat: scheduler jobs allocate an async work scope per tick.
      timing[heartbeatAt] = now();
      heartbeat = enabled
        ? runInDetachedAsyncContext(() => setInterval(observeLoop, HEARTBEAT_MS).unref())
        : undefined;
      if (enabled && !versions.bun) {
        const stop = promiseHooks.createHook(continuations);
        stopContinuations = () => stop();
      } else {
        stopContinuations?.();
        stopContinuations = undefined;
        if (resumedPromise !== undefined) {
          resumedPromise = undefined;
          active = false;
        }
      }
    },
    drain() {
      // The health sampler may be the first timer to resume after a blocked loop.
      if (heartbeat) {
        observeLoop();
      }
      const stalls = pending.splice(0);
      const omitted = dropped;
      const omittedUnattributed = unattributedDropped;
      dropped = 0;
      unattributedDropped = 0;
      const maximum = timing[delayMaxMs]!;
      timing[delayMaxMs] = 0;
      return {
        stalls,
        dropped: omitted,
        unattributedDropped: omittedUnattributed,
        delayMaxMs: maximum,
      };
    },
    reset() {
      timing[heartbeatAt] = now();
      pending.length = 0;
      dropped = 0;
      unattributedDropped = 0;
      timing[delayMaxMs] = 0;
      timing[startedAt] = timing[segmentAt] = now();
      timing[longestMs] = 0;
      longestTask = task;
      longestPhase = phase;
    },
    stop: () => observer.stop(),
  };
}
