import { availableParallelism } from "node:os";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export const DEFAULT_WORKER_PENDING_TASKS = 128;
export const DEFAULT_WORKER_PENDING_BYTES = 256 * 1024 * 1024;

export type WorkerComputePermit = { requestCheckpoint: () => boolean };

/** Shared compute admission; database and generation workers keep their own ordering. */
export function getWorkerComputeCapacity() {
  return resolveGlobalSingleton(Symbol.for("openclaw.workerComputeCapacity"), () => {
    const limit = Math.max(1, availableParallelism() - 1);
    const active = new Set<WorkerComputePermit>();
    const waiting = new Set<() => void>();
    let pendingTasks = 0;
    let pendingBytes = 0;
    let draining = false;
    const requestCheckpoints = () => {
      let demand = waiting.size;
      if (demand) {
        for (const permit of active) {
          if (permit.requestCheckpoint() && --demand === 0) {
            break;
          }
        }
      }
    };
    const drain = () => {
      if (draining) {
        return;
      }
      draining = true;
      try {
        while (active.size < limit && waiting.size) {
          const next = waiting.values().next().value!;
          waiting.delete(next);
          next();
        }
      } finally {
        draining = false;
      }
      requestCheckpoints();
    };
    return {
      admit(bytes: number): boolean {
        if (
          pendingTasks >= DEFAULT_WORKER_PENDING_TASKS ||
          pendingBytes + bytes > DEFAULT_WORKER_PENDING_BYTES
        ) {
          return false;
        }
        pendingTasks++;
        pendingBytes += bytes;
        return true;
      },
      finish(bytes: number) {
        pendingTasks--;
        pendingBytes -= bytes;
      },
      acquire(
        resume: () => void,
        requestCheckpoint: () => boolean,
      ): WorkerComputePermit | undefined {
        // A newly submitting pool must not overtake an already waiting pool.
        if (active.size >= limit || (!draining && waiting.size)) {
          waiting.add(resume);
          requestCheckpoints();
          return undefined;
        }
        const permit = { requestCheckpoint };
        active.add(permit);
        return permit;
      },
      release(permit: WorkerComputePermit) {
        active.delete(permit);
        drain();
      },
      remove(resume: () => void) {
        waiting.delete(resume);
      },
      requestCheckpoints,
    };
  });
}

export type WorkerComputeAdmission = { ready: Promise<void>; release(): void };

/** Retain shared capacity across preparation and cleanup owned outside a task pool. */
export function reserveWorkerComputeCapacity(
  signal: AbortSignal,
  inputBytes: number,
): WorkerComputeAdmission | undefined {
  signal.throwIfAborted();
  const capacity = getWorkerComputeCapacity();
  if (!capacity.admit(inputBytes)) {
    return undefined;
  }
  const ready = createDeferredCore();
  let permit: WorkerComputePermit | undefined;
  let waiting = false;
  let released = false;
  const removeWaiting = () => {
    if (waiting) {
      waiting = false;
      capacity.remove(resume);
    }
  };
  const abort = () => {
    removeWaiting();
    ready.reject(signal.reason);
  };
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    removeWaiting();
    signal.removeEventListener("abort", abort);
    if (permit) {
      capacity.release(permit);
    }
    capacity.finish(inputBytes);
    ready.reject(signal.reason ?? new Error("Worker compute admission released"));
  };
  const resume = () => {
    waiting = false;
    if (released || signal.aborted) {
      ready.reject(signal.reason);
      return;
    }
    try {
      permit = capacity.acquire(resume, () => false);
      waiting = !permit;
      if (permit) {
        ready.resolve();
      } else if (signal.aborted) {
        abort();
      }
    } catch (error) {
      capacity.remove(resume);
      ready.reject(error);
      release();
    }
  };
  signal.addEventListener("abort", abort, { once: true });
  resume();
  return { ready: ready.promise, release };
}
