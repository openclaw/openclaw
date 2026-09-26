import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { MessagePort, Worker } from "node:worker_threads";
import { asNonNegativeFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { DiagnosticMemoryUsage } from "./diagnostic-process-types.js";
import { normalizeDiagnosticWorkerScript } from "./worker-diagnostic-script.js";

type WorkerSource = {
  script: string;
  cpuUsage: () => Promise<NodeJS.CpuUsage | undefined>;
  heap?: {
    value: Pick<NodeJS.MemoryUsage, "heapUsed" | "heapTotal" | "external"> & {
      arrayBuffers?: number;
    };
    sampledAt: number;
  };
  heapPending?: boolean;
  memoryPort?: MessagePort;
  memoryPending?: boolean;
  memoryUnavailable?: boolean;
};

function workerScriptName(filename: string | URL, evalSource = false): string {
  // Never retain eval source, arbitrary filenames, or installation paths in diagnostics.
  if (evalSource || (filename instanceof URL && filename.protocol !== "file:")) {
    return "other";
  }
  const name = basename(filename instanceof URL ? fileURLToPath(filename) : filename).replace(
    /\.[cm]?ts$/u,
    ".js",
  );
  return normalizeDiagnosticWorkerScript(name);
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
  trackedWorkers.workers.get(worker)?.memoryPort?.close();
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
  const previous = source.heap;
  try {
    const heap = await worker.getHeapStatistics();
    // A late native interrupt must not replace a newer, complete port sample.
    if (source.heap === previous) {
      source.heap = {
        value: {
          heapUsed: heap.used_heap_size,
          heapTotal: heap.total_heap_size,
          external: heap.external_memory,
        },
        sampledAt: performance.now(),
      };
      source.memoryUnavailable = false;
    }
  } catch {
    source.memoryUnavailable = true;
  } finally {
    source.heapPending = false;
  }
}

/** The existing registry owns this channel until native exit, never the submitting task. */
export function receiveWorkerMemoryPort(worker: Worker, message: unknown): boolean {
  if (!isRecord(message) || message.status !== "memory" || !(message.port instanceof MessagePort)) {
    return false;
  }
  const port = message.port;
  const source = trackedWorkers.workers.get(worker);
  if (!source || source.memoryPort || worker.threadId === -1) {
    port.close();
    return true;
  }
  source.memoryPort = port;
  source.memoryPending = true;
  const close = () => {
    source.memoryPort = undefined;
    source.memoryPending = false;
    source.memoryUnavailable = true;
    port.close();
  };
  port.on("message", (value: unknown) => {
    const record = isRecord(value) ? value : {};
    const heapUsed = asNonNegativeFiniteNumber(record.heapUsed);
    const heapTotal = asNonNegativeFiniteNumber(record.heapTotal);
    const external = asNonNegativeFiniteNumber(record.external);
    const arrayBuffers = asNonNegativeFiniteNumber(record.arrayBuffers);
    if (
      heapUsed === undefined ||
      heapTotal === undefined ||
      external === undefined ||
      arrayBuffers === undefined
    ) {
      close();
      return;
    }
    source.heap = {
      value: { heapUsed, heapTotal, external, arrayBuffers },
      sampledAt: performance.now(),
    };
    source.memoryPending = false;
    source.memoryUnavailable = false;
  });
  port.once("close", close);
  port.once("messageerror", close);
  port.unref();
  return true;
}

/** Read completed samples without blocking the heartbeat on a busy native isolate. */
export function sampleTrackedWorkerMemory() {
  pruneExitedWorkers();
  const workerHeaps: NonNullable<DiagnosticMemoryUsage["workerHeaps"]> = [];
  const workerMemoryMissing: NonNullable<DiagnosticMemoryUsage["workerMemoryMissing"]> = [];
  const memory = {
    workerCount: trackedWorkers.workers.size,
    workerHeapSampledCount: 0,
    workerHeapTotalBytes: 0,
    workerHeapUsedBytes: 0,
    workerExternalBytes: 0,
    workerArrayBuffersBytes: 0,
    workerArrayBuffersSampledCount: 0,
    workerMemoryScope: "direct" as const,
    workerMemoryMissing,
    workerHeaps,
  };
  for (const [worker, source] of trackedWorkers.workers) {
    // At most two heartbeat intervals old; exits remove both counters and samples.
    const sampleAgeMs = source.heap ? performance.now() - source.heap.sampledAt : undefined;
    if (source.heap && sampleAgeMs !== undefined && sampleAgeMs < 60_000) {
      memory.workerHeapSampledCount++;
      memory.workerHeapTotalBytes += source.heap.value.heapTotal;
      memory.workerHeapUsedBytes += source.heap.value.heapUsed;
      memory.workerExternalBytes += source.heap.value.external;
      if (source.heap.value.arrayBuffers !== undefined) {
        memory.workerArrayBuffersSampledCount++;
        memory.workerArrayBuffersBytes += source.heap.value.arrayBuffers;
      }
      memory.workerHeaps.push({
        script: source.script,
        threadId: worker.threadId,
        ...source.heap.value,
        sampleAgeMs: Math.round(sampleAgeMs),
      });
    } else {
      memory.workerMemoryMissing.push({
        script: source.script,
        threadId: worker.threadId,
        reason: source.heap ? "stale" : source.memoryUnavailable ? "unavailable" : "pending",
      });
    }
    // Native heap interrupts cannot be canceled. Never queue another behind a stall.
    if (source.memoryPort) {
      if (!source.memoryPending) {
        source.memoryPending = true;
        try {
          source.memoryPort.postMessage(undefined, []);
        } catch {
          source.memoryPort.close();
          source.memoryPort = undefined;
          source.memoryPending = false;
          source.memoryUnavailable = true;
        }
      }
    }
    // V8 interrupts can still run while busy JavaScript cannot handle port events.
    if (
      !source.heapPending &&
      (!source.memoryPort ||
        source.heap?.value.arrayBuffers === undefined ||
        (sampleAgeMs !== undefined && sampleAgeMs >= 60_000))
    ) {
      void refreshWorkerHeap(worker, source);
    }
  }
  const heapUnavailable = memory.workerCount > 0 && memory.workerHeapSampledCount === 0;
  const buffersUnavailable = memory.workerCount > 0 && memory.workerArrayBuffersSampledCount === 0;
  const workerMemoryCoverage: NonNullable<DiagnosticMemoryUsage["workerMemoryCoverage"]> =
    heapUnavailable
      ? "unavailable"
      : memory.workerArrayBuffersSampledCount < memory.workerCount
        ? "partial"
        : "complete";
  return {
    ...memory,
    workerMemoryCoverage,
    workerHeapTotalBytes: heapUnavailable ? undefined : memory.workerHeapTotalBytes,
    workerHeapUsedBytes: heapUnavailable ? undefined : memory.workerHeapUsedBytes,
    workerExternalBytes: heapUnavailable ? undefined : memory.workerExternalBytes,
    workerArrayBuffersBytes: buffersUnavailable ? undefined : memory.workerArrayBuffersBytes,
  };
}
