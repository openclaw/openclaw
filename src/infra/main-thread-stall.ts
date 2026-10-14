import { performance } from "node:perf_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const STALL_MS = 1_000;
const MAX_PENDING_STALLS = 8;

type Stall = { elapsedMs: number; task: string; taskMs: number };
type TaskObserver = { enter(name: string): () => void; stop(): void };
type MainThreadTaskState = { observer?: TaskObserver };

const taskState = resolveGlobalSingleton<MainThreadTaskState>(
  Symbol.for("openclaw.mainThreadTask"),
  () => ({}),
);

/** Name code-owned work only; request text, paths, and identifiers do not belong in labels. */
export function runWithMainThreadTask<T>(name: string, run: () => Promise<T>): Promise<T>;
export function runWithMainThreadTask<T>(name: string, run: () => T): T;
export function runWithMainThreadTask(name: string, run: () => unknown): unknown {
  const observer = taskState.observer;
  if (!observer) {
    return run();
  }
  const exit = observer.enter(name);
  try {
    return run();
  } finally {
    exit();
  }
}

/** Measure explicit synchronous scopes; unscoped stalls rely on best-effort loop sampling. */
export function createMainThreadStallMonitor(now: () => number = () => performance.now()) {
  taskState.observer?.stop();
  const pending: Stall[] = [];
  let stopped = false;
  let dropped = 0;
  let delayMaxMs = 0;
  let depth = 0;
  let startedAt = 0;
  let segmentAt = 0;
  let task = "unattributed";
  let longestTask = task;
  let longestMs = 0;
  const segment = (at: number) => {
    const elapsed = at - segmentAt;
    if (elapsed > longestMs) {
      longestTask = task;
      longestMs = elapsed;
    }
    segmentAt = at;
  };
  const before = () => {
    if (depth++ !== 0) {
      return;
    }
    startedAt = segmentAt = now();
    task = longestTask = "unattributed";
    longestMs = 0;
  };
  const after = () => {
    if (depth === 0 || --depth !== 0) {
      return;
    }
    const at = now();
    segment(at);
    const elapsedMs = at - startedAt;
    delayMaxMs = Math.max(delayMaxMs, elapsedMs);
    if (elapsedMs > STALL_MS) {
      if (pending.length < MAX_PENDING_STALLS) {
        pending.push({ elapsedMs, task: longestTask, taskMs: longestMs });
      } else {
        dropped++;
      }
    }
  };
  const observer: TaskObserver = {
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      if (taskState.observer === observer) {
        delete taskState.observer;
      }
      pending.length = 0;
      dropped = 0;
      delayMaxMs = 0;
    },
    enter(name) {
      const ownsTurn = depth === 0;
      if (ownsTurn) {
        before();
      }
      segment(now());
      const previous = task;
      task = name;
      return () => {
        segment(now());
        task = previous;
        if (ownsTurn) {
          after();
        }
      };
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
    },
    stop: () => observer.stop(),
  };
}
