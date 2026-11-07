import { AsyncLocalStorage } from "node:async_hooks";
import { readFile as readFileCallback, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { hasErrnoCode } from "../infra/errno.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

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

export type HostExecMemoryBudget = { memoryBytes: number; swapBytes: number };
export type HostExecMemoryUsage = HostExecMemoryBudget;

function constrainToCgroupAncestors(capacity: HostExecMemoryBudget): void {
  let relative: string | undefined;
  try {
    relative = /^0::(\/.*)$/mu.exec(readFileSync("/proc/self/cgroup", "utf8"))?.[1];
  } catch {
    return;
  }
  if (!relative) {
    return;
  }
  const mount = "/sys/fs/cgroup";
  let directory = path.resolve(mount, `.${relative}`);
  if (directory !== mount && !directory.startsWith(`${mount}/`)) {
    return;
  }
  // Node only reads the current cgroup. Delegated Gateway leaves can have no
  // memory files even though a service or slice above them limits RAM and swap.
  for (;;) {
    for (const file of ["memory.max", "memory.high", "memory.swap.max"]) {
      try {
        const value = readFileSync(path.join(directory, file), "utf8").trim();
        if (/^\d+$/u.test(value)) {
          const dimension = file === "memory.swap.max" ? "swapBytes" : "memoryBytes";
          capacity[dimension] = Math.min(capacity[dimension], Number(value));
        }
      } catch {
        // Missing controllers and inaccessible ancestors retain known limits.
      }
    }
    // A cgroup namespace can expose a constrained container at the mount root.
    if (directory === mount) {
      break;
    }
    directory = path.dirname(directory);
  }
}

/** Reserve physical RAM for the host and Gateway; swap is a separate, finite allowance. */
function resolveHostExecMemoryBudget(): HostExecMemoryBudget | undefined {
  if (process.platform !== "linux") {
    return undefined;
  }
  const constrained = process.constrainedMemory();
  const capacity = {
    memoryBytes: constrained > 0 ? Math.min(os.totalmem(), constrained) : os.totalmem(),
    swapBytes: 0,
  };
  try {
    capacity.swapBytes =
      Number(/^SwapTotal:\s+(\d+)/mu.exec(readFileSync("/proc/meminfo", "utf8"))?.[1] ?? 0) * 1024;
  } catch {
    // Without swap facts, do not promise additional capacity.
  }
  constrainToCgroupAncestors(capacity);
  const total = capacity.memoryBytes;
  const gatewayRss = process.memoryUsage.rss();
  const hostReserve = Math.max(256 * 1024 ** 2, total / 8);
  const gatewayReserve = Math.max(total / 8, gatewayRss * 1.5);
  // Extra growth reserves must not make a formerly fitting command unusable on
  // a small host. This floor is shared by all commands, rather than multiplied.
  const singleCommandAllowance = Math.min(total / 4, (total - gatewayRss) / 2);
  const memoryBytes = Math.max(
    1,
    Math.floor(Math.max(total - hostReserve - gatewayReserve, singleCommandAllowance)),
  );
  return {
    // Whole MiB survive cgroup page rounding, avoiding repeated memory.high
    // writes (and writer-side reclaim on older kernels) for an unchanged budget.
    memoryBytes:
      memoryBytes < 1024 ** 2 ? memoryBytes : Math.floor(memoryBytes / 1024 ** 2) * 1024 ** 2,
    swapBytes: Math.floor(Math.min(capacity.swapBytes, total / 4)),
  };
}

type Census = {
  memory: (pid: number) => Promise<HostExecMemoryUsage>;
  children: (pid: number) => Promise<number[]>;
};
type Snapshot = { pids: Map<number, HostExecMemoryUsage>; extra: HostExecMemoryUsage };
type Watch = {
  due: number;
  snapshot: Snapshot;
  cancelling: boolean;
  sample: (census: Census) => Promise<void>;
  limit: (observed: HostExecMemoryUsage, budget: HostExecMemoryBudget) => Promise<void>;
};
const owner = resolveGlobalSingleton(
  Symbol.for("openclaw.hostExecMemory"),
  (): {
    budget?: HostExecMemoryBudget;
    watches: Set<Watch>;
    timer?: NodeJS.Timeout;
    sampling: boolean;
    assessmentPending: boolean;
  } => ({
    watches: new Set(),
    sampling: false,
    assessmentPending: false,
  }),
);

/** Keep one automatic budget for this Gateway owner. */
export function getHostExecMemoryBudget(): HostExecMemoryBudget | undefined {
  if (process.platform !== "linux") {
    return undefined;
  }
  return (owner.budget ??= resolveHostExecMemoryBudget());
}

function formatLimit(observed: HostExecMemoryUsage, budget: HostExecMemoryBudget): string {
  const mib = (bytes: number) => Math.ceil(bytes / 1024 ** 2);
  return `Command killed because the shared host exec memory budget was exceeded (RAM ${mib(observed.memoryBytes)}/${mib(budget.memoryBytes)} MiB; swap ${mib(observed.swapBytes)}/${mib(budget.swapBytes)} MiB). Reduce concurrent work or input size. Check completed side effects before retrying; commands are never automatically replayed.`;
}

/** Share parsed facts within a tick, without retaining procfs buffers or thread directories. */
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

async function readMemory(pid: number): Promise<HostExecMemoryUsage> {
  const status = await readFile(`/proc/${pid}/status`);
  return {
    memoryBytes: readStatusNumber(status, rssField) * 1024,
    swapBytes: readStatusNumber(status, swapField) * 1024,
  };
}

/** Durable units retain descendants even after their MainPID exits. */
export async function readCgroupMemoryUsage(directory: string): Promise<HostExecMemoryUsage> {
  const [memory, swap] = await Promise.all([
    readFile(`${directory}/memory.current`),
    readFile(`${directory}/memory.swap.current`),
  ]);
  const memoryBytes = Number(memory.toString().trim());
  const swapBytes = Number(swap.toString().trim());
  if (
    !Number.isFinite(memoryBytes) ||
    memoryBytes < 0 ||
    !Number.isFinite(swapBytes) ||
    swapBytes < 0
  ) {
    throw new Error("Host exec cgroup memory usage is unavailable");
  }
  return { memoryBytes, swapBytes };
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

/** Follow every thread's children, including native-worker subprocesses. */
async function readTreeMemory(
  rootPid: number,
  stopped: () => boolean,
  census: Census,
): Promise<Snapshot> {
  const pids = new Map<number, HostExecMemoryUsage>();
  const seen = new Set([rootPid]);
  for (const pid of seen) {
    if (stopped()) {
      break;
    }
    try {
      pids.set(pid, await census.memory(pid));
      if (stopped()) {
        break;
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
  return { pids, extra: { memoryBytes: 0, swapBytes: 0 } };
}

function totalUsage(): HostExecMemoryUsage {
  const total = { memoryBytes: 0, swapBytes: 0 };
  const pids = new Map<number, HostExecMemoryUsage>();
  for (const { snapshot } of owner.watches) {
    total.memoryBytes += snapshot.extra.memoryBytes;
    total.swapBytes += snapshot.extra.swapBytes;
    for (const [pid, usage] of snapshot.pids) {
      const previous = pids.get(pid);
      // Overlapping retained roots share a charge. Shared pages across distinct
      // processes can still overcount; the sampled backend is conservative.
      pids.set(pid, {
        memoryBytes: Math.max(previous?.memoryBytes ?? 0, usage.memoryBytes),
        swapBytes: Math.max(previous?.swapBytes ?? 0, usage.swapBytes),
      });
    }
  }
  for (const usage of pids.values()) {
    total.memoryBytes += usage.memoryBytes;
    total.swapBytes += usage.swapBytes;
  }
  return total;
}

function nearBudget(usage: HostExecMemoryUsage, budget: HostExecMemoryBudget): boolean {
  return (
    usage.memoryBytes >= budget.memoryBytes / 2 ||
    (usage.swapBytes > 0 && usage.swapBytes >= budget.swapBytes / 2)
  );
}

function assess() {
  if (owner.assessmentPending) {
    return;
  }
  owner.assessmentPending = true;
  queueMicrotask(() => {
    owner.assessmentPending = false;
    const budget = getHostExecMemoryBudget();
    if (!budget) {
      return;
    }
    const total = totalUsage();
    if (nearBudget(total, budget)) {
      for (const watch of owner.watches) {
        if (Number.isFinite(watch.due)) {
          watch.due = Math.min(watch.due, performance.now() + 1000);
        }
      }
      schedule();
    }
    const dimension =
      total.memoryBytes > budget.memoryBytes
        ? "memoryBytes"
        : total.swapBytes > budget.swapBytes
          ? "swapBytes"
          : undefined;
    // Retain the victim's charge until its native cleanup owner unregisters it.
    // One cancellation in flight avoids killing peers before that cleanup settles.
    if (!dimension || Array.from(owner.watches).some((watch) => watch.cancelling)) {
      return;
    }
    let victim: Watch | undefined;
    let largest = 0;
    for (const watch of owner.watches) {
      let bytes = watch.snapshot.extra[dimension];
      for (const usage of watch.snapshot.pids.values()) {
        bytes += usage[dimension];
      }
      if (bytes > largest) {
        largest = bytes;
        victim = watch;
      }
    }
    if (victim) {
      const selected = victim;
      selected.cancelling = true;
      void selected.limit(total, budget).catch(() => {
        // A failed manager request did not settle native cleanup. Retain the
        // charge and retry on the next ordinary sample instead of blocking peers.
        selected.cancelling = false;
        process.emitWarning(
          "Host exec memory cancellation failed; shared memory protection is degraded",
        );
      });
    }
  });
}

function schedule() {
  clearTimeout(owner.timer);
  if (owner.sampling || !owner.watches.size) {
    return;
  }
  const due = Math.min(...Array.from(owner.watches, (watch) => watch.due));
  if (!Number.isFinite(due)) {
    return;
  }
  owner.timer = runInDetachedAsyncContext(() =>
    setTimeout(() => sample(), Math.max(0, Math.ceil(due - performance.now()))),
  );
  owner.timer.unref();
}

function sample() {
  owner.sampling = true;
  const due = Array.from(owner.watches).filter((watch) => watch.due <= performance.now() + 999);
  const census = { memory: shareReads(readMemory), children: shareReads(readChildren) };
  for (const watch of due) {
    watch.due = Infinity;
    void watch.sample(census).catch(() => {});
  }
  // Pending trees settle independently; one stalled read cannot block peers.
  owner.sampling = false;
  schedule();
}

/** One installation owner accounts ordinary trees and disjoint durable cgroups. */
export function watchHostExecMemory(
  params: (
    | { pid: number; readUsage?: never }
    | {
        pid?: never;
        readUsage: () => Promise<HostExecMemoryUsage>;
      }
  ) & {
    onLimit: () => void | Promise<void>;
    onDiagnostic: (text: string) => void;
  },
): () => void {
  if (!getHostExecMemoryBudget()) {
    return () => {};
  }
  let warned = false;
  const empty = { memoryBytes: 0, swapBytes: 0 };
  const watch: Watch = {
    due: performance.now() + 1000,
    snapshot: { pids: new Map(), extra: empty },
    cancelling: false,
    limit: AsyncLocalStorage.bind(async (observed, budget) => {
      try {
        params.onDiagnostic(`\n${formatLimit(observed, budget)}\n`);
      } finally {
        await params.onLimit();
      }
    }),
    sample: AsyncLocalStorage.bind(async (census) => {
      if (!owner.watches.has(watch)) {
        return;
      }
      let intervalMs = 1000;
      try {
        const snapshot = params.readUsage
          ? { pids: new Map<number, HostExecMemoryUsage>(), extra: await params.readUsage() }
          : await readTreeMemory(params.pid, () => !owner.watches.has(watch), census);
        if (!owner.watches.has(watch)) {
          return;
        }
        const previousPids = watch.snapshot.pids;
        watch.snapshot = snapshot;
        intervalMs = 5000;
        if (
          Array.from(snapshot.pids.keys()).some(
            (pid) => !previousPids.has(pid) && pid !== params.pid,
          )
        ) {
          intervalMs = 1000;
        }
        assess();
      } catch {
        if (owner.watches.has(watch) && !warned) {
          warned = true;
          params.onDiagnostic(
            "\nWarning: OpenClaw could not read workload memory usage; shared memory protection is degraded. Check procfs and cgroup permissions.\n",
          );
        }
      } finally {
        watch.due = performance.now() + intervalMs;
        schedule();
      }
    }),
  };
  owner.watches.add(watch);
  schedule();
  return () => {
    owner.watches.delete(watch);
    schedule();
  };
}
