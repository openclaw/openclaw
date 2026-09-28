/// <reference lib="es2024.sharedmemory" />
import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const CANCELLED = 1;
const SECTION = 2;

export type WorkerNativeSectionState = Int32Array<SharedArrayBuffer>;

// Lazy runtime chunks share the carrier, not the authority of an individual task.
const currentNativeSection = resolveGlobalSingleton(
  Symbol.for("openclaw.workerTaskNativeSection"),
  () => new AsyncLocalStorage<() => () => void>(),
);

export type WorkerTaskControl = {
  /** Await one bounded native operation before allowing the worker to be terminated. */
  runNativeSection: <T>(operation: () => T | Promise<T>) => Promise<T>;
  throwIfCancelled: () => void;
};

function assertWorkerTaskActive(observed: number, isActive: () => boolean): void {
  if (!isActive() || (observed & CANCELLED) !== 0) {
    throw new Error("worker task cancelled");
  }
}

function acquireWorkerNativeSection(
  state: WorkerNativeSectionState,
  isActive: () => boolean,
): () => void {
  for (;;) {
    const observed = Atomics.load(state, 0);
    assertWorkerTaskActive(observed, isActive);
    if (Atomics.compareExchange(state, 0, observed, observed + SECTION) === observed) {
      break;
    }
  }
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    Atomics.sub(state, 0, SECTION);
    Atomics.notify(state, 0);
  };
}

/** Make this task's native custody available without retaining ordinary task work. */
export function withWorkerTaskNativeSectionScope<T>(
  state: WorkerNativeSectionState,
  isActive: () => boolean,
  run: () => T,
): T {
  return currentNativeSection.run(() => acquireWorkerNativeSection(state, isActive), run);
}

/** Acquire before a durable side effect; release only after its cleanup or settlement. */
export function retainCurrentWorkerNativeSection(): () => void {
  return currentNativeSection.getStore()?.() ?? (() => {});
}

export function createWorkerNativeSectionState(): WorkerNativeSectionState {
  return new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
}

export function cancelWorkerNativeSections(state: WorkerNativeSectionState): void {
  // Close admission atomically: a worker cannot enter after retirement observes no sections.
  Atomics.or(state, 0, CANCELLED);
  Atomics.notify(state, 0);
}

export function observeWorkerTaskCancellation(
  state: WorkerNativeSectionState,
  isActive: () => boolean,
  onCancelled: () => void,
): () => Promise<void> {
  let observing = true;
  const settled = (async () => {
    for (;;) {
      if (!observing || !isActive()) {
        return;
      }
      const observed = Atomics.load(state, 0);
      if ((observed & CANCELLED) !== 0) {
        onCancelled();
        return;
      }
      await Atomics.waitAsync(state, 0, observed).value;
    }
  })();
  return () => {
    observing = false;
    // Normal task completion must also wake and join its otherwise indefinite wait.
    Atomics.notify(state, 0);
    return settled;
  };
}

export function waitForWorkerNativeSections(
  state: WorkerNativeSectionState,
): Promise<void> | undefined {
  if (Atomics.load(state, 0) < SECTION) {
    return undefined;
  }
  return (async () => {
    for (;;) {
      const observed = Atomics.load(state, 0);
      if (observed < SECTION) {
        return;
      }
      await Atomics.waitAsync(state, 0, observed).value;
    }
  })();
}

export function releaseWorkerNativeSectionsOnExit(state: WorkerNativeSectionState): void {
  // Actual exit proves even an interrupted or failed section no longer owns native resources.
  Atomics.store(state, 0, CANCELLED);
  Atomics.notify(state, 0);
}

export function createWorkerTaskControl(
  state: WorkerNativeSectionState,
  isActive: () => boolean,
): WorkerTaskControl {
  const throwIfCancelled = () => assertWorkerTaskActive(Atomics.load(state, 0), isActive);
  return {
    throwIfCancelled,
    runNativeSection: async <T>(operation: () => T | Promise<T>): Promise<T> => {
      const release = acquireWorkerNativeSection(state, isActive);
      let result: T;
      try {
        result = await operation();
      } finally {
        release();
      }
      throwIfCancelled();
      return result;
    },
  };
}
