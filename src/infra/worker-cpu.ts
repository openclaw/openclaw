import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { HeapInfo } from "node:v8";
import { Worker } from "node:worker_threads";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { DiagnosticMemoryUsage } from "./diagnostic-process-types.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";

type WorkerSource = {
  script: string;
  cpuUsage: () => Promise<NodeJS.CpuUsage | undefined>;
  heap?: { value: HeapInfo; sampledAt: number };
  heapPending?: boolean;
};

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
  return { revision: 0, workers: new Map<Worker, WorkerSource>() };
});

export function createCpuTrackedWorker(...args: ConstructorParameters<typeof Worker>): Worker {
  const worker = new Worker(...args);
  trackWorker(worker); // Bun need not emit Node's process-level Worker event.
  // Node's process event can register the Worker before its constructor returns.
  trackedWorkers.workers.get(worker)!.script = workerScriptName(args[0], args[1]?.eval);
  return worker;
}

function forgetWorker(worker: Worker): void {
  if (trackedWorkers.workers.delete(worker)) {
    trackedWorkers.revision++;
  }
}

function trackWorker(worker: Worker): void {
  if (trackedWorkers.workers.has(worker)) {
    return;
  }
  let pending = false;
  trackedWorkers.workers.set(worker, {
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
  });
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
