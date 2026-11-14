import { AsyncLocalStorage } from "node:async_hooks";
import { readFile as readFileCallback } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import { hasErrnoCode } from "../infra/errno.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";

const rssField = Buffer.from("\nVmRSS:");
const swapField = Buffer.from("\nVmSwap:");

// Avoid fs/promises' extra promise layers for every tiny procfs read.
const readFile = promisify(readFileCallback);

function readStatusNumber(buffer: Buffer, field: Buffer): number {
  // status starts with Name, so these fields always follow a newline.
  const start = buffer.indexOf(field);
  if (start < 0) {
    return 0;
  }
  let offset = start + field.length;
  while (buffer[offset] === 32 || buffer[offset] === 9) {
    offset++;
  }
  let value = 0;
  while (true) {
    const digit = buffer[offset++];
    if (digit === undefined || digit < 48 || digit > 57) {
      return value;
    }
    value = value * 10 + digit - 48;
  }
}

/** Host exec budgets physical memory, not V8/Go's virtual address reservations. */
export function resolveHostExecMemoryLimit(): number | undefined {
  if (process.platform !== "linux") {
    return undefined;
  }
  const constrained = process.constrainedMemory();
  const total = constrained > 0 ? Math.min(os.totalmem(), constrained) : os.totalmem();
  return Math.max(1, Math.floor(Math.min(total / 4, (total - process.memoryUsage.rss()) / 2)));
}

function formatChildMemoryLimit(limitBytes: number, observedBytes: number): string {
  return `Command killed for exceeding its host memory bound (${Math.ceil(observedBytes / 1024 ** 2)} MiB observed; ${Math.ceil(limitBytes / 1024 ** 2)} MiB limit). Reduce command concurrency or input size, split the work, or use a separately resource-limited worker.`;
}

type Census = {
  memory: (pid: number) => Promise<number>;
  children: (pid: number) => Promise<number[]>;
};

/** Share parsed facts within one tick, without retaining procfs buffers or thread directories. */
function shareReads<T>(read: (pid: number) => Promise<T>): (pid: number) => Promise<T> {
  const reads = new Map<number, Promise<T>>();
  return (pid) => {
    let pending = reads.get(pid);
    if (!pending) {
      pending = read(pid);
      reads.set(pid, pending);
    }
    return pending;
  };
}

async function readMemory(pid: number): Promise<number> {
  const status = await readFile(`/proc/${pid}/status`);
  return (readStatusNumber(status, rssField) + readStatusNumber(status, swapField)) * 1024;
}

async function readChildren(pid: number): Promise<number[]> {
  const pids: number[] = [];
  // Complete one PID's shared discovery even if a consumer stops.
  for (const tid of await readdir(`/proc/${pid}/task`)) {
    try {
      const children = await readFile(`/proc/${pid}/task/${tid}/children`);
      let childPid = 0;
      for (let offset = 0; offset <= children.length; offset++) {
        const digit = children[offset];
        if (digit !== undefined && digit >= 48 && digit <= 57) {
          childPid = childPid * 10 + digit - 48;
        } else {
          if (childPid > 0) {
            pids.push(childPid);
          }
          childPid = 0;
        }
      }
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT") && !hasErrnoCode(error, "ESRCH")) {
        throw error;
      }
    }
  }
  return pids;
}

/** Follow every thread's children: native worker threads can spawn subprocesses too. */
async function readTreeMemory(
  rootPid: number,
  limitBytes: number,
  isStopped: () => boolean,
  census: Census,
): Promise<{ bytes: number; pids: Set<number> }> {
  const seen = new Set([rootPid]);
  let bytes = 0;
  for (const pid of seen) {
    if (isStopped()) {
      return { bytes, pids: seen };
    }
    try {
      // Include swapped private pages so swapping cannot hide a runaway allocation.
      bytes += await census.memory(pid);
      if (bytes > limitBytes) {
        return { bytes, pids: seen };
      }
      if (isStopped()) {
        return { bytes, pids: seen };
      }
      for (const child of await census.children(pid)) {
        seen.add(child);
      }
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT") && !hasErrnoCode(error, "ESRCH")) {
        throw error;
      }
    }
  }
  return { bytes, pids: seen };
}

type Watch = {
  // Pending reads have no new deadline until that watch settles.
  due: number;
  sample: (census: Census) => Promise<void>;
};
const watches = new Set<Watch>();
let timer: NodeJS.Timeout | undefined;
let sampling = false;

function schedule() {
  clearTimeout(timer);
  if (sampling || !watches.size) {
    return;
  }
  const due = Math.min(...Array.from(watches, (watch) => watch.due));
  if (!Number.isFinite(due)) {
    return;
  }
  timer = runInDetachedAsyncContext(() =>
    setTimeout(() => void sample(), Math.max(0, Math.ceil(due - performance.now()))),
  );
  timer.unref();
}

async function sample() {
  sampling = true;
  // Align near-due watches early, never extend their one/five-second deadline.
  const due = Array.from(watches).filter((watch) => watch.due <= performance.now() + 999);
  try {
    // Ancestry also covers children that move out of the exec cgroup.
    const census = {
      memory: shareReads(readMemory),
      children: shareReads(readChildren),
    };
    for (const watch of due) {
      watch.due = Infinity;
      void watch.sample(census).catch(() => {});
    }
    // Pending trees settle independently; one stalled read cannot block peer limits.
    await Promise.resolve();
  } finally {
    sampling = false;
    schedule();
  }
}

/** Nonoverlapping samples: every second near the bound or after discovering descendants. */
export function watchChildMemory(params: {
  pid?: number;
  limitBytes?: number;
  onLimit: (observedBytes: number) => void;
  onDiagnostic: (text: string) => void;
}): () => void {
  const { pid, limitBytes } = params;
  if (process.platform !== "linux" || !pid || !limitBytes) {
    return () => {};
  }
  let warned = false;
  let previousPids = new Set([pid]);
  const watch: Watch = {
    due: performance.now() + 1000,
    // The shared timer is detached; callbacks retain this command's own context.
    sample: AsyncLocalStorage.bind(async (census: Census) => {
      if (!watches.has(watch)) {
        return;
      }
      let intervalMs = 1000;
      try {
        const { bytes, pids } = await readTreeMemory(
          pid,
          limitBytes,
          () => !watches.has(watch),
          census,
        );
        intervalMs = bytes < limitBytes / 2 ? 5000 : 1000;
        for (const childPid of pids) {
          if (!previousPids.has(childPid)) {
            intervalMs = 1000;
          }
        }
        previousPids = pids;
        if (watches.has(watch) && bytes > limitBytes) {
          stop();
          params.onLimit(bytes);
          params.onDiagnostic(`\n${formatChildMemoryLimit(limitBytes, bytes)}\n`);
        }
      } catch {
        if (watches.has(watch) && !warned) {
          warned = true;
          params.onDiagnostic(
            "\nWarning: OpenClaw could not read child memory usage; memory protection is degraded. Check procfs permissions.\n",
          );
        }
      } finally {
        watch.due = performance.now() + intervalMs;
        schedule();
      }
    }),
  };
  const stop = () => {
    watches.delete(watch);
    schedule();
  };
  watches.add(watch);
  schedule();
  return stop;
}
