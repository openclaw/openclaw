import type { BigIntStats } from "node:fs";
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { PackageFileHashJob, HashResult } from "./package-update-integrity-hasher.types.js";
import { resolveRuntimeProcessEntrypointUrl } from "./runtime-process-url.js";
import { resolveRuntimeWorkerThreadExecArgv } from "./runtime-worker-url.js";

declare const SEALED_RUNTIME_BUILD: boolean;

export type PackageFileHasher = {
  hash: (file: string, stat: BigIntStats) => Promise<string>;
  flush: () => void;
  close: () => void;
};

const log = createSubsystemLogger("update/package-integrity");

type Task = {
  job: PackageFileHashJob;
  stat: BigIntStats;
  resolve: (digest: string) => void;
  reject: (error: unknown) => void;
};
type Slot = { worker: Worker; tasks: Task[]; closing: boolean; failed: boolean };

/** One walk owns its workers, queue, and fallback; no file bytes survive a job. */
export function createPackageFileHasher(fallback: PackageFileHasher["hash"]): PackageFileHasher {
  const width = Math.min(4, availableParallelism());
  const batchSize = 16;
  const cancel = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const slots: Slot[] = [];
  const queued: Task[] = [];
  let closed = false;
  let flushing = false;
  // The independently sealed recovery helper has no sibling modules. Its existing
  // in-process path keeps hashing inside the recorded recovery artifact.
  let inProcess = typeof SEALED_RUNTIME_BUILD === "boolean" && SEALED_RUNTIME_BUILD;
  let fallbackRunning = 0;

  function retire(slot: Slot) {
    if (slot.closing) {
      return;
    }
    slot.closing = true;
    if (slot.tasks.length) {
      // Let the current sync syscall reach its finally; cancellation skips the
      // rest of the batch. A timed-out reader must not await this OS work.
      try {
        slot.worker.postMessage("close", []);
      } catch {
        // An unavailable channel is reconciled by the worker's exit event.
      }
      slot.worker.unref();
    } else {
      void slot.worker.terminate().catch(() => {});
    }
  }

  function useFallback(error: unknown) {
    if (!inProcess) {
      inProcess = true;
      Atomics.store(cancel, 0, 1);
      try {
        log.debug("package-file-hasher-fallback", { error });
      } catch {
        // Logging must not replace a package result.
      }
      for (const slot of slots) {
        retire(slot);
      }
    }
    dispatch();
  }

  function dispatch() {
    if (closed || !queued.length) {
      flushing = false;
      return;
    }
    if (inProcess) {
      // Healthy workers may still be finishing their last batch after a peer
      // fails. Together with fallback hashes, at most four files own OS work.
      const busy = slots.filter((slot) => slot.tasks.length).length;
      while (queued.length && fallbackRunning + busy < 4) {
        const task = queued.shift()!;
        fallbackRunning++;
        void Promise.resolve()
          .then(() => fallback(task.job.file, task.stat))
          .then(task.resolve, task.reject)
          .finally(() => {
            fallbackRunning--;
            dispatch();
          });
      }
      return;
    }
    if (!flushing && queued.length < batchSize) {
      return;
    }
    let slot = slots.find((candidate) => !candidate.tasks.length);
    if (!slot && slots.length < width) {
      try {
        const url = resolveRuntimeProcessEntrypointUrl("packageIntegrityHasher");
        const worker = new Worker(url, {
          execArgv: resolveRuntimeWorkerThreadExecArgv(url),
          // Builtin-only reads need no ambient preload or compile-cache writes.
          env: {},
          workerData: { cancel },
        });
        slot = { worker, tasks: [], closing: false, failed: false };
        slots.push(slot);
        const owner = slot;
        worker.on("message", (results: HashResult[]) => {
          if (owner.failed) {
            return;
          }
          const tasks = owner.tasks;
          owner.tasks = [];
          for (const [index, task] of tasks.entries()) {
            const result = results[index]!;
            if ("cancelled" in result) {
              if (closed) {
                task.reject(new Error("Package file hashing cancelled"));
              } else {
                queued.push(task);
              }
            } else if ("error" in result) {
              const { message, ...fields } = result.error;
              task.reject(
                Object.assign(
                  new Error(message),
                  Object.fromEntries(
                    Object.entries(fields).filter(([, value]) => value !== undefined),
                  ),
                ),
              );
            } else {
              task.resolve(result.digest);
            }
          }
          dispatch();
        });
        const failed = (error: unknown) => {
          owner.failed = true;
          useFallback(error);
        };
        worker.on("error", failed);
        worker.on("messageerror", failed);
        worker.on("exit", (code) => {
          const tasks = owner.tasks;
          owner.tasks = [];
          if (!owner.closing && !closed) {
            useFallback(new Error(`Package file hashing worker exited (${code})`));
          }
          if (tasks.length) {
            if (closed) {
              for (const task of tasks) {
                task.reject(new Error("Package file hashing cancelled"));
              }
            } else {
              queued.push(...tasks);
              useFallback(new Error(`Package file hashing worker exited (${code})`));
            }
          }
          dispatch();
        });
      } catch (error) {
        useFallback(error);
        return;
      }
    }
    if (slot) {
      slot.tasks = queued.splice(0, batchSize);
      try {
        slot.worker.postMessage(
          slot.tasks.map((task) => task.job),
          [],
        );
        if (!queued.length) {
          flushing = false;
        } else {
          dispatch();
        }
      } catch (error) {
        slot.failed = true;
        useFallback(error);
      }
    }
  }

  return {
    hash(file, stat) {
      if (closed) {
        return Promise.reject(new Error("Package file hashing cancelled"));
      }
      const { dev, ino, mode, uid, gid, nlink, size, mtimeNs, ctimeNs } = stat;
      return new Promise((resolve, reject) => {
        queued.push({
          job: { file, dev, ino, mode, uid, gid, nlink, size, mtimeNs, ctimeNs },
          stat,
          resolve,
          reject,
        });
        dispatch();
      });
    },
    flush() {
      flushing = true;
      dispatch();
    },
    close() {
      closed = true;
      Atomics.store(cancel, 0, 1);
      for (const task of queued.splice(0)) {
        task.reject(new Error("Package file hashing cancelled"));
      }
      for (const slot of slots) {
        retire(slot);
      }
    },
  };
}
