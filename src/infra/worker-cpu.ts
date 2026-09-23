import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { HeapInfo } from "node:v8";
import { Worker } from "node:worker_threads";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { DiagnosticMemoryUsage } from "./diagnostic-process-types.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";

type WorkerSource = {
  script: string;
  started?: boolean;
  retirementReason?: WorkerRetirementReason;
  cpuUsage: () => Promise<NodeJS.CpuUsage | undefined>;
  heap?: { value: HeapInfo; sampledAt: number };
  heapPending?: boolean;
};

export type WorkerRetirementReason =
  | "idle_timeout"
  | "memory_pressure"
  | "closed"
  | "rotation"
  | "cancelled"
  | "failure"
  | "exit";

const workerScriptNames = new Set([
  ...Object.values(runtimeProcessEntrypoints).map((entry) => basename(entry.distWorkerPath)),
  // Pools with source/standalone-plugin entrypoints outside the process manifest.
  "catalog-page.worker.js",
  "code-mode.worker.js",
  "compaction-planning.worker.js",
  "disk-budget.worker.js",
  "document-extractor.worker.js",
  "manager-index.worker.js",
  "manager-search.worker.js",
  "memory-index.worker.js",
  "memory-search.worker.js",
  "session-history.worker.js",
  "audio-worker.runtime.js",
  "realtime-quicksilver-audio.worker.js",
  "realtime-quicksilver-socket.worker.js",
  "telegram-ingress-worker.runtime.js",
]);

function workerScriptName(filename: string | URL, evalSource = false): string {
  // Never retain eval source, arbitrary filenames, or installation paths in diagnostics.
  if (evalSource || (filename instanceof URL && filename.protocol !== "file:")) {
    return "other";
  }
  const name = basename(filename instanceof URL ? fileURLToPath(filename) : filename).replace(
    /\.[cm]?ts$/u,
    ".js",
  );
  return workerScriptNames.has(name) ? name : "other";
}

// Native exit, not pool retirement or Gateway reset, ends resource-counter ownership.
// Shared chunks must see the same workers; this registry never starts a sampler.
const trackedWorkers = resolveGlobalSingleton(Symbol.for("openclaw.workerCpuSources"), () => {
  // Node also reports direct plugin/dependency Workers here, without a second registry.
  process.on("worker", trackWorker);
  return {
    revision: 0,
    workers: new Map<Worker, WorkerSource>(),
    lifecycle: new Map<string, { started: number; retired: Map<WorkerRetirementReason, number> }>(),
  };
});

export function createCpuTrackedWorker(...args: ConstructorParameters<typeof Worker>): Worker {
  const worker = new Worker(...args);
  trackWorker(worker); // Bun need not emit Node's process-level Worker event.
  // Node's process event can register the Worker before its constructor returns.
  trackedWorkers.workers.get(worker)!.script = workerScriptName(args[0], args[1]?.eval);
  return worker;
}

function forgetWorker(worker: Worker): void {
  const source = trackedWorkers.workers.get(worker);
  if (!source) {
    return;
  }
  const counts = countWorkerStart(source);
  const reason = source.retirementReason ?? "exit";
  counts.retired.set(reason, (counts.retired.get(reason) ?? 0) + 1);
  trackedWorkers.workers.delete(worker);
  trackedWorkers.revision++;
}

function countWorkerStart(source: WorkerSource) {
  let counts = trackedWorkers.lifecycle.get(source.script);
  if (!counts) {
    counts = { started: 0, retired: new Map<WorkerRetirementReason, number>() };
    trackedWorkers.lifecycle.set(source.script, counts);
  }
  if (!source.started) {
    source.started = true;
    counts.started++;
  }
  return counts;
}

/** Record the owner's reason now; only confirmed native exit increments retirement. */
export function markWorkerRetirement(worker: Worker, reason: WorkerRetirementReason): void {
  const source = trackedWorkers.workers.get(worker);
  if (source) {
    source.retirementReason ??= reason;
  }
}

function trackWorker(worker: Worker): void {
  if (trackedWorkers.workers.has(worker)) {
    return;
  }
  let pending = false;
  const source: WorkerSource = {
    script: "other",
    async cpuUsage() {
      // Worker.cpuUsage cannot cancel an interrupt blocked in native work. Keep
      // at most one outstanding request even across sampler resets/restarts.
      if (pending) {
        return undefined;
      }
      pending = true;
      try {
        return await worker.cpuUsage();
      } catch {
        return undefined;
      } finally {
        pending = false;
      }
    },
  };
  trackedWorkers.workers.set(worker, source);
  // Node emits "worker" inside the constructor, before the wrapper assigns its script.
  queueMicrotask(() => countWorkerStart(source));
  trackedWorkers.revision++;
  worker.once("exit", () => forgetWorker(worker));
}

function pruneExitedWorkers(): void {
  // A consumer may remove all exit listeners during its own cleanup.
  for (const worker of trackedWorkers.workers.keys()) {
    if (worker.threadId === -1) {
      forgetWorker(worker);
    }
  }
}

export function getTrackedWorkerCpuSources(): {
  revision: number;
  workers: { cpuUsage: () => Promise<NodeJS.CpuUsage | undefined> }[];
} {
  pruneExitedWorkers();
  return { revision: trackedWorkers.revision, workers: [...trackedWorkers.workers.values()] };
}

async function refreshWorkerHeap(worker: Worker, source: WorkerSource): Promise<void> {
  source.heapPending = true;
  try {
    source.heap = { value: await worker.getHeapStatistics(), sampledAt: performance.now() };
  } catch {
    source.heap = undefined;
  } finally {
    source.heapPending = false;
  }
}

/** Read completed samples without blocking the heartbeat on a busy native isolate. */
export function sampleTrackedWorkerMemory() {
  pruneExitedWorkers();
  const workerHeaps: NonNullable<DiagnosticMemoryUsage["workerHeaps"]> = [];
  const memory = {
    workerCount: trackedWorkers.workers.size,
    workerHeapSampledCount: 0,
    workerHeapTotalBytes: 0,
    workerHeapUsedBytes: 0,
    workerHeaps,
    workerLifecycle: [...trackedWorkers.lifecycle].map(([script, counts]) => ({
      script,
      started: counts.started,
      retired: [...counts.retired].map(([reason, count]) => ({ reason, count })),
    })),
  };
  for (const [worker, source] of trackedWorkers.workers) {
    // At most two heartbeat intervals old; exits remove both counters and samples.
    if (source.heap && performance.now() - source.heap.sampledAt < 60_000) {
      memory.workerHeapSampledCount++;
      memory.workerHeapTotalBytes += source.heap.value.total_heap_size;
      memory.workerHeapUsedBytes += source.heap.value.used_heap_size;
      memory.workerHeaps.push({
        script: source.script,
        heapUsed: source.heap.value.used_heap_size,
        heapTotal: source.heap.value.total_heap_size,
      });
    }
    // Native heap interrupts cannot be canceled. Never queue another behind a stall.
    if (!source.heapPending) {
      void refreshWorkerHeap(worker, source);
    }
  }
  return memory;
}
