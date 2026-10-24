import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const STALL_MS = 250;
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
  const pending: { elapsedMs: number; task: string; taskMs: number }[] = [];
  let stopped = false;
  let dropped = 0;
  let delayMaxMs = 0;
  let active = false;
  let startedAt = 0;
  let segmentAt = 0;
  let task = "unattributed";
  let phase: string | undefined;
  let longestTask = task;
  let longestPhase: string | undefined;
  let longestMs = 0;
  const segment = (at: number) => {
    const elapsed = at - segmentAt;
    if (elapsed > longestMs) {
      longestTask = task;
      longestPhase = phase;
      longestMs = elapsed;
    }
    segmentAt = at;
  };
  const observer: TaskObserver = {
    currentName: () => (active ? task : undefined),
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      if (taskState.observer === observer) {
        delete taskState.observer;
        taskState.context.disable();
      }
      pending.length = 0;
      dropped = 0;
      delayMaxMs = 0;
    },
    run(name, run, taskPhase) {
      const enteredAt = now();
      const ownsTurn = !active;
      if (ownsTurn) {
        active = true;
        startedAt = segmentAt = enteredAt;
        task = longestTask = "unattributed";
        phase = longestPhase = undefined;
        longestMs = 0;
      } else {
        segment(enteredAt);
      }
      const previous = task;
      const previousPhase = phase;
      task = name;
      phase = taskPhase;
      try {
        return taskPhase === undefined ? taskState.context.run(name, run) : run();
      } finally {
        const at = now();
        segment(at);
        task = previous;
        phase = previousPhase;
        if (ownsTurn) {
          active = false;
          const elapsedMs = at - startedAt;
          delayMaxMs = Math.max(delayMaxMs, elapsedMs);
          if (elapsedMs >= STALL_MS) {
            if (pending.length < MAX_PENDING_STALLS) {
              pending.push({
                elapsedMs,
                task: longestPhase ? `${longestTask}:${longestPhase}` : longestTask,
                taskMs: longestMs,
              });
            } else {
              dropped++;
            }
          }
        }
      }
    },
  };
  taskState.observer = observer;
  return {
    drain() {
      const stalls = pending.splice(0);
      const omitted = dropped;
      dropped = 0;
      const maximum = delayMaxMs;
      delayMaxMs = 0;
      return { stalls, dropped: omitted, delayMaxMs: maximum };
    },
    reset() {
      pending.length = 0;
      dropped = 0;
      delayMaxMs = 0;
      startedAt = segmentAt = now();
      longestMs = 0;
      longestTask = task;
      longestPhase = phase;
    },
    stop: () => observer.stop(),
  };
}
