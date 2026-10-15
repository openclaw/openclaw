import type { BigIntStats } from "node:fs";
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { createSubsystemLogger } from "../logging/subsystem.js";

type FileIdentity = Pick<
  BigIntStats,
  "dev" | "ino" | "mode" | "uid" | "gid" | "nlink" | "size" | "mtimeNs" | "ctimeNs"
>;
type PackageFileHashJob = FileIdentity & { file: string };
type HashError = {
  message: string;
  code?: string;
  errno?: number;
  syscall?: string;
  path?: string;
};
type HashResult = { digest: string } | { error: HashError } | { cancelled: true };
export type PackageFileHasher = {
  hash: (file: string, stat: BigIntStats) => Promise<string>;
  flush: () => void;
  close: () => void;
};

const log = createSubsystemLogger("update/package-integrity");
// The sealed recovery.mjs has no adjacent worker module. Inline CommonJS uses only
// Node builtins in Node/Bun, the installed CLI, and recovery. WorkerTaskPool forbids
// eval and can terminate a blocking syscall before its descriptor's finally runs.
const workerSource = String.raw`
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const { parentPort, workerData: { cancel } } = require("node:worker_threads");
const buffer = Buffer.allocUnsafe(64 * 1024);
const fields = ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs"];
const unchanged = (job, stat) => job.ino !== 0n && fields.every(key => job[key] === stat[key]);
const cancelled = Symbol("cancelled");
// The owner sets cancellation when its deadline expires; start no further I/O.
const admit = () => {
  if (Atomics.load(cancel, 0)) throw cancelled;
};
function hash(job) {
  admit();
  const fd = fs.openSync(job.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    admit();
    if (!unchanged(job, fs.fstatSync(fd, { bigint: true }))) {
      throw new Error("Package rollback file changed before reading");
    }
    const digest = createHash("sha256");
    const size = Number(job.size);
    let position = 0;
    while (position < size) {
      admit();
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
      if (count === 0) {
        throw new Error("Package rollback file changed while reading");
      }
      position += count;
      digest.update(buffer.subarray(0, count));
    }
    admit();
    if (!unchanged(job, fs.fstatSync(fd, { bigint: true }))) {
      throw new Error("Package rollback file changed while reading");
    }
    return { digest: digest.digest("hex") };
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}
parentPort.on("message", jobs => {
  if (jobs === "close") {
    parentPort.close();
    return;
  }
  const results = jobs.map(job => {
    try {
      return hash(job);
    } catch (error) {
      if (error === cancelled) return { cancelled: true };
      const { message, code, errno, syscall, path } = error;
      return { error: { message, code, errno, syscall, path } };
    }
  });
  parentPort.postMessage(results);
});
`;

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
  let inProcess = false;
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
        const worker = new Worker(workerSource, {
          eval: true,
          execArgv: [],
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
