import { AsyncLocalStorage } from "node:async_hooks";
import { readFile as readFileCallback } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import { hasErrnoCode } from "../infra/errno.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";

const rssField = Buffer.from("\nVmRSS:");
const swapField = Buffer.from("\nVmSwap:");
const parentField = Buffer.from("\nPPid:");

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

type Forest = {
  memory: Map<number, number>;
  children: Map<number, number[]>;
};

async function readForest(isExpired: () => boolean): Promise<Forest | undefined> {
  const memory = new Map<number, number>();
  const children = new Map<number, number[]>();
  try {
    for (const entry of await readdir("/proc")) {
      if (!watches.size || isExpired()) {
        return undefined;
      }
      const pid = Number(entry);
      if (!Number.isInteger(pid) || pid <= 0) {
        continue;
      }
      try {
        const status = await readFile(`/proc/${pid}/status`);
        memory.set(
          pid,
          (readStatusNumber(status, rssField) + readStatusNumber(status, swapField)) * 1024,
        );
        const parent = readStatusNumber(status, parentField);
        const siblings = children.get(parent);
        if (siblings) {
          siblings.push(pid);
        } else {
          children.set(parent, [pid]);
        }
      } catch (error) {
        if (!hasErrnoCode(error, "ENOENT") && !hasErrnoCode(error, "ESRCH")) {
          throw error;
        }
      }
    }
    return { memory, children };
  } catch {
    // An unreadable unrelated process must not disable protection of owned trees.
    return undefined;
  }
}

/** Follow every thread's children: native worker threads can spawn subprocesses too. */
async function readTreeMemory(
  rootPid: number,
  limitBytes: number,
  isStopped: () => boolean,
  forest?: Forest,
): Promise<{ bytes: number; pids: Set<number> }> {
  const seen = new Set([rootPid]);
  let bytes = 0;
  for (const pid of seen) {
    if (isStopped()) {
      return { bytes, pids: seen };
    }
    try {
      // Include swapped private pages so swapping cannot hide a runaway allocation.
      if (forest) {
        bytes += forest.memory.get(pid) ?? 0;
      } else {
        const status = await readFile(`/proc/${pid}/status`);
        bytes += (readStatusNumber(status, rssField) + readStatusNumber(status, swapField)) * 1024;
      }
      if (bytes > limitBytes) {
        return { bytes, pids: seen };
      }
      if (forest) {
        for (const child of forest.children.get(pid) ?? []) {
          seen.add(child);
        }
        continue;
      }
      for (const tid of await readdir(`/proc/${pid}/task`)) {
        if (isStopped()) {
          return { bytes, pids: seen };
        }
        try {
          const children = await readFile(`/proc/${pid}/task/${tid}/children`);
          let childPid = 0;
          for (let offset = 0; offset <= children.length; offset++) {
            const digit = children[offset];
            if (digit !== undefined && digit >= 48 && digit <= 57) {
              childPid = childPid * 10 + digit - 48;
            } else {
              if (childPid > 0) {
                seen.add(childPid);
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
  sample: (forest?: Forest) => Promise<void>;
};
const watches = new Set<Watch>();
let timer: NodeJS.Timeout | undefined;
let sampling = false;
let shared = false;
let census: Promise<Forest | undefined> | undefined;

function schedule() {
  clearTimeout(timer);
  if (!watches.size) {
    shared = false;
  }
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
  // The 200-process crossover wins from twelve watches; enter at twenty for headroom.
  shared = watches.size >= (shared ? 12 : 20);
  // Align near-due watches early, never extend their one/five-second deadline.
  const due = Array.from(watches).filter((watch) => watch.due <= performance.now() + 999);
  try {
    let forest: Forest | undefined;
    if (shared && !census) {
      let expired = false;
      let deadline: NodeJS.Timeout | undefined;
      // A stalled unrelated procfs read must not hold other commands' enforcement.
      census = readForest(() => expired).finally(() => {
        census = undefined;
      });
      try {
        forest = await Promise.race([
          census,
          new Promise<undefined>((resolve) => {
            deadline = setTimeout(() => {
              expired = true;
              resolve(undefined);
            }, 250);
            deadline.unref();
          }),
        ]);
      } finally {
        clearTimeout(deadline);
      }
    }
    for (const watch of due) {
      watch.due = Infinity;
      void watch.sample(forest).catch(() => {});
    }
    // Settle ready forest sums together; pending individual walks remain independent.
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
    sample: AsyncLocalStorage.bind(async (forest?: Forest) => {
      if (!watches.has(watch)) {
        return;
      }
      let intervalMs = 1000;
      try {
        const { bytes, pids } = await readTreeMemory(
          pid,
          limitBytes,
          () => !watches.has(watch),
          forest,
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
