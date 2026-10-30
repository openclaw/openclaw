import { readFile as readFileCallback } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import { hasErrnoCode } from "../infra/errno.js";

const rssField = Buffer.from("\nVmRSS:");
const swapField = Buffer.from("\nVmSwap:");

// Avoid fs/promises' extra promise layers for every tiny procfs read.
const readFile = promisify(readFileCallback);

function readKilobytes(buffer: Buffer, field: Buffer): number {
  // status starts with Name, so memory fields always follow a newline.
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

/** Follow every thread's children: native worker threads can spawn subprocesses too. */
async function readTreeMemory(
  rootPid: number,
  limitBytes: number,
  isStopped: () => boolean,
): Promise<{ bytes: number; pids: Set<number> }> {
  const pending = [rootPid];
  const seen = new Set(pending);
  let bytes = 0;
  for (const pid of pending) {
    if (isStopped()) {
      return { bytes, pids: seen };
    }
    try {
      const status = await readFile(`/proc/${pid}/status`);
      // Include swapped private pages so swapping cannot hide a runaway allocation.
      bytes += (readKilobytes(status, rssField) + readKilobytes(status, swapField)) * 1024;
      if (bytes > limitBytes) {
        return { bytes, pids: seen };
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
              if (childPid > 0 && !seen.has(childPid)) {
                seen.add(childPid);
                pending.push(childPid);
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
  let stopped = false;
  let warned = false;
  let previousPids = new Set([pid]);
  let timer: NodeJS.Timeout | undefined;
  const sample = async () => {
    let intervalMs = 1000;
    try {
      const { bytes, pids } = await readTreeMemory(pid, limitBytes, () => stopped);
      intervalMs = bytes < limitBytes / 2 ? 5000 : 1000;
      for (const childPid of pids) {
        if (!previousPids.has(childPid)) {
          intervalMs = 1000;
        }
      }
      previousPids = pids;
      if (!stopped && bytes > limitBytes) {
        stopped = true;
        params.onLimit(bytes);
        params.onDiagnostic(`\n${formatChildMemoryLimit(limitBytes, bytes)}\n`);
      }
    } catch {
      if (!stopped && !warned) {
        warned = true;
        params.onDiagnostic(
          "\nWarning: OpenClaw could not read child memory usage; memory protection is degraded. Check procfs permissions.\n",
        );
      }
    } finally {
      if (!stopped) {
        timer = setTimeout(() => void sample(), intervalMs);
        timer.unref();
      }
    }
  };
  timer = setTimeout(() => void sample(), 1000);
  timer.unref();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
