/// <reference lib="es2024.sharedmemory" />

const CANCELLED = 1;
const SECTION = 2;

export type WorkerNativeSectionState = Int32Array<SharedArrayBuffer>;

export type WorkerTaskControl = {
  /** Await one bounded native operation before allowing the worker to be terminated. */
  runNativeSection: <T>(operation: () => T | Promise<T>) => Promise<T>;
  throwIfCancelled: () => void;
};

export function createWorkerNativeSectionState(): WorkerNativeSectionState {
  return new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
}

export function cancelWorkerNativeSections(state: WorkerNativeSectionState): void {
  // Close admission atomically: a worker cannot enter after retirement observes no sections.
  Atomics.or(state, 0, CANCELLED);
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
  const assertActive = (observed: number) => {
    if (!isActive() || (observed & CANCELLED) !== 0) {
      throw new Error("worker task cancelled");
    }
  };
  const throwIfCancelled = () => assertActive(Atomics.load(state, 0));
  return {
    throwIfCancelled,
    runNativeSection: async <T>(operation: () => T | Promise<T>): Promise<T> => {
      for (;;) {
        const observed = Atomics.load(state, 0);
        assertActive(observed);
        if (Atomics.compareExchange(state, 0, observed, observed + SECTION) === observed) {
          break;
        }
      }
      let result: T;
      try {
        result = await operation();
      } finally {
        Atomics.sub(state, 0, SECTION);
        Atomics.notify(state, 0);
      }
      throwIfCancelled();
      return result;
    },
  };
}
