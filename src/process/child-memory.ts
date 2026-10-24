import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import { hasErrnoCode } from "../infra/errno.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";

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

function parseProcNumbers(data: Buffer, memory: boolean, consume: (value: number) => void): void {
  let column = 0;
  let rss = true;
  let swap = true;
  let value = 0;
  let digits = false;
  for (let i = 0; i < data.length; i++) {
    const byte = data.readUInt8(i);
    if (memory) {
      rss &&= column >= 6 || byte === "VmRSS:".charCodeAt(column);
      swap &&= column >= 7 || byte === "VmSwap:".charCodeAt(column);
    }
    if ((!memory || rss || swap) && byte >= 48 && byte <= 57) {
      value = value * 10 + byte - 48;
      digits = true;
    } else if (digits) {
      consume(value * (memory ? 1024 : 1));
      value = 0;
      digits = false;
    }
    column++;
    if (byte === 10) {
      column = 0;
      rss = swap = true;
    }
  }
  if (digits) {
    consume(value * (memory ? 1024 : 1));
  }
}

/** Follow every thread's children: native worker threads can spawn subprocesses too. */
async function readTreeMemory(
  rootPid: number,
  limitBytes: number,
  isStopped: () => boolean,
): Promise<number> {
  const pending = [rootPid];
  const seen = new Set(pending);
  let bytes = 0;
  const addMemory = (value: number) => (bytes += value);
  const addChild = (childPid: number) => {
    if (childPid > 0 && !seen.has(childPid)) {
      seen.add(childPid);
      pending.push(childPid);
    }
  };
  for (const pid of pending) {
    if (isStopped()) {
      return bytes;
    }
    try {
      // Include swapped private pages so swapping cannot hide a runaway allocation.
      parseProcNumbers(await readFile(`/proc/${pid}/status`), true, addMemory);
      if (bytes > limitBytes) {
        return bytes;
      }
      for (const tid of await readdir(`/proc/${pid}/task`)) {
        if (isStopped()) {
          return bytes;
        }
        try {
          parseProcNumbers(await readFile(`/proc/${pid}/task/${tid}/children`), false, addChild);
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
  return bytes;
}

type MemoryWatch = {
  pid?: number;
  limitBytes?: number;
  onLimit: (observedBytes: number) => void;
  onDiagnostic: (text: string) => void;
};
const watches = new Set<MemoryWatch & { pid: number; limitBytes: number; warned: boolean }>();
let timer: NodeJS.Timeout | undefined;
let sampling = false;

async function sample(): Promise<void> {
  timer = undefined;
  sampling = true;
  // Trees admitted while reads are pending join the next tick.
  try {
    await Promise.all(
      Array.from(watches, async (watch) => {
        const stopped = () => !watches.has(watch);
        if (stopped()) {
          return;
        }
        try {
          const bytes = await readTreeMemory(watch.pid, watch.limitBytes, stopped);
          if (!stopped() && bytes > watch.limitBytes) {
            watches.delete(watch);
            watch.onLimit(bytes);
            watch.onDiagnostic(`\n${formatChildMemoryLimit(watch.limitBytes, bytes)}\n`);
          }
        } catch {
          if (!stopped() && !watch.warned) {
            watch.warned = true;
            watch.onDiagnostic(
              "\nWarning: OpenClaw could not read child memory usage; memory protection is degraded. Check procfs permissions.\n",
            );
          }
        }
      }),
    );
  } finally {
    sampling = false;
    if (watches.size > 0) {
      scheduleSample();
    }
  }
}

function scheduleSample() {
  timer = runInDetachedAsyncContext(() => setTimeout(() => void sample(), 1000));
  timer.unref();
}

/** One nonoverlapping sampler; execution-tree owners retain their own budgets. */
export function watchChildMemory(params: MemoryWatch): () => void {
  const { pid, limitBytes } = params;
  if (process.platform !== "linux" || !pid || !limitBytes) {
    return () => {};
  }
  const watch = { ...params, pid, limitBytes, warned: false };
  watches.add(watch);
  if (!timer && !sampling) {
    scheduleSample();
  }
  return () => {
    watches.delete(watch);
    if (watches.size === 0) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
}
