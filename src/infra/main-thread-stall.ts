import { AsyncLocalStorage, createHook } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const STALL_MS = 1_000;
const MAX_PENDING_STALLS = 8;

type Stall = { elapsedMs: number; task: string; taskMs: number };
type TaskObserver = { enter(name: string): () => void; stop(): void };
type TaskScope = { name: string; active: boolean };
type MainThreadTaskState = { context: AsyncLocalStorage<TaskScope>; observer?: TaskObserver };

const taskState = resolveGlobalSingleton<MainThreadTaskState>(
  Symbol.for("openclaw.mainThreadTask"),
  () => ({ context: new AsyncLocalStorage<TaskScope>() }),
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
  const scope: TaskScope = { name, active: true };
  const finish = () => {
    scope.active = false;
  };
  try {
    const result = taskState.context.run(scope, run);
    // Detached descendants keep the context, but no longer own a completed task's label.
    if (isPromiseLike(result)) {
      return Promise.resolve(result).finally(finish);
    }
    finish();
    return result;
  } catch (error) {
    finish();
    throw error;
  } finally {
    exit();
  }
}

/** Measure callback execution, never the time an async operation spends awaiting I/O. */
export function createMainThreadStallMonitor(now: () => number = () => performance.now()) {
  taskState.observer?.stop();
  const pending: Stall[] = [];
  let stopped = false;
  let dropped = 0;
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
    const scope = taskState.context.getStore();
    task = longestTask = scope?.active ? scope.name : "unattributed";
    longestMs = 0;
  };
  const after = () => {
    if (depth === 0 || --depth !== 0) {
      return;
    }
    const at = now();
    segment(at);
    const elapsedMs = at - startedAt;
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
      hook.disable();
      if (taskState.observer === observer) {
        delete taskState.observer;
      }
      pending.length = 0;
      dropped = 0;
    },
    enter(name) {
      // Activation can occur within an already-running callback, before its hook was enabled.
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
  // No init/destroy hooks or async-id map: each turn retains only its longest named segment.
  const hook = createHook({ before, after });
  taskState.observer = observer;
  hook.enable();
  return {
    drain() {
      const stalls = pending.splice(0);
      const omitted = dropped;
      dropped = 0;
      return { stalls, dropped: omitted };
    },
    stop: () => observer.stop(),
  };
}
