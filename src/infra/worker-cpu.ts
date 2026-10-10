import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { MessagePort, Worker } from "node:worker_threads";
import {
  asNonNegativeFiniteNumber,
  asPositiveFiniteNumber,
} from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { WorkerRetirementReason } from "@openclaw/worker-runtime";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { DiagnosticMemoryUsage } from "./diagnostic-process-types.js";
import "./worker-ancestry.js";
import { normalizeDiagnosticWorkerScript } from "./worker-diagnostic-script.js";

type WorkerCpuHandle = {
  readonly threadId: number;
  cpuUsage: Worker["cpuUsage"];
  getHeapStatistics: Worker["getHeapStatistics"];
  once(event: "exit", listener: () => void): unknown;
};

type WorkerSource = {
  script: string;
  poolId?: number;
  started?: boolean;
  retirementReason?: WorkerRetirementReason;
  cpuUsage: () => Promise<NodeJS.CpuUsage | undefined>;
  heap?: {
    value: Pick<NodeJS.MemoryUsage, "heapUsed" | "heapTotal" | "external"> & {
      arrayBuffers?: number;
      heapSizeLimitBytes?: number;
    };
    sampledAt: number;
  };
  heapPending?: boolean;
  memoryPort?: MessagePort;
  memoryPending?: boolean;
  memoryUnavailable?: boolean;
};

export type { WorkerRetirementReason } from "@openclaw/worker-runtime";

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
  return {
    revision: 0,
    nextPoolId: 0,
    poolIds: new WeakMap<object, number>(),
    workers: new Map<WorkerCpuHandle, WorkerSource>(),
    lifecycle: new Map<string, { started: number; retired: Map<WorkerRetirementReason, number> }>(),
  };
});

export function createCpuTrackedWorker(...args: ConstructorParameters<typeof Worker>): Worker {
  const worker = new Worker(...args);
  trackNativeWorkerForCpu(worker, args[0], args[1]?.eval);
  return worker;
}

/** Register a physical child only after its native lifetime owner confirms construction. */
export function trackNativeWorkerForCpu(
  worker: WorkerCpuHandle,
  filename: string | URL,
  evalSource = false,
): void {
  // Register explicitly on Bun; Node may already have reported the Worker during construction.
  trackWorker(worker);
  trackedWorkers.workers.get(worker)!.script = workerScriptName(filename, evalSource);
}

/** Pool identity follows its live Workers without retaining the pool itself. */
export function attributeWorkerToPool(worker: WorkerCpuHandle, pool: object): void {
  const source = trackedWorkers.workers.get(worker);
  if (!source) {
    return;
  }
  let poolId = trackedWorkers.poolIds.get(pool);
  if (poolId === undefined) {
    poolId = ++trackedWorkers.nextPoolId;
    trackedWorkers.poolIds.set(pool, poolId);
  }
  source.poolId = poolId;
}

/** A bounded census of live pools, including Workers whose retirement is pending. */
export function getTrackedWorkerPoolSnapshot() {
  pruneExitedWorkers();
  const pools = new Map<number, { poolId: number; script: string; workerCount: number }>();
  for (const source of trackedWorkers.workers.values()) {
    if (source.poolId === undefined) {
      continue;
    }
    const pool = pools.get(source.poolId);
    if (pool) {
      pool.workerCount++;
    } else {
      pools.set(source.poolId, { poolId: source.poolId, script: source.script, workerCount: 1 });
    }
  }
  return {
    workerCount: trackedWorkers.workers.size,
    workerPoolCount: pools.size,
    workerPools: [...pools.values()]
      .toSorted((a, b) => b.workerCount - a.workerCount || a.poolId - b.poolId)
      .slice(0, 100),
  };
}

function forgetWorker(worker: WorkerCpuHandle): void {
  const source = trackedWorkers.workers.get(worker);
  if (!source) {
    return;
  }
  const counts = countWorkerStart(source);
  const reason = source.retirementReason ?? "exit";
  counts.retired.set(reason, (counts.retired.get(reason) ?? 0) + 1);
  source.memoryPort?.close();
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
export function markWorkerRetirement(
  worker: WorkerCpuHandle,
  reason: WorkerRetirementReason,
): void {
  const source = trackedWorkers.workers.get(worker);
  if (source) {
    source.retirementReason ??= reason;
  }
}

function trackWorker(worker: WorkerCpuHandle): void {
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

async function refreshWorkerHeap(worker: WorkerCpuHandle, source: WorkerSource): Promise<void> {
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
          heapSizeLimitBytes: process.versions.bun ? undefined : heap.heap_size_limit,
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
export function receiveWorkerMemoryPort(worker: WorkerCpuHandle, message: unknown): boolean {
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
    const heapSizeLimitBytes = asPositiveFiniteNumber(record.heapSizeLimitBytes);
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
      value: { heapUsed, heapTotal, external, arrayBuffers, heapSizeLimitBytes },
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

/** Read lifecycle counters without requesting native CPU or heap interrupts. */
export function getTrackedWorkerLifecycleSnapshot() {
  pruneExitedWorkers();
  return {
    workerCount: trackedWorkers.workers.size,
    workerLifecycle: [...trackedWorkers.lifecycle].map(([script, counts]) => ({
      script,
      started: counts.started,
      retired: [...counts.retired].map(([reason, count]) => ({ reason, count })),
    })),
  };
}

/** Read completed samples without blocking the heartbeat on a busy native isolate. */
export function sampleTrackedWorkerMemory() {
  const workerHeaps: NonNullable<DiagnosticMemoryUsage["workerHeaps"]> = [];
  const workerMemoryMissing: NonNullable<DiagnosticMemoryUsage["workerMemoryMissing"]> = [];
  const memory = {
    ...getTrackedWorkerLifecycleSnapshot(),
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
