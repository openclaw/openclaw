import "../../worker-heap-flag.mjs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread, MessagePort, Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { WorkerRetirementReason } from "@openclaw/worker-runtime";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { DiagnosticMemoryUsage } from "./diagnostic-process-types.js";
import type { GcSample } from "./gc-observer.js";
import { runWithMainThreadTask } from "./main-thread-stall.js";
import {
  MAX_DIAGNOSTIC_WORKER_SLOTS,
  normalizeDiagnosticWorkerScript,
} from "./worker-diagnostic-script.js";
import {
  recordWorkerMessage,
  observeWorkerMessage,
  workerMessagePayloadBytes,
} from "./worker-message-metrics.js";

type WorkerMemorySample = Pick<
  NodeJS.MemoryUsage,
  "heapUsed" | "heapTotal" | "external" | "arrayBuffers"
> & { heapSizeLimitBytes?: number; gc?: GcSample[] };

type WorkerCpuHandle = {
  readonly threadId: number;
  cpuUsage: Worker["cpuUsage"];
  getHeapStatistics: Worker["getHeapStatistics"];
  once(event: "exit", listener: () => void): unknown;
};

type WorkerSource = {
  script: string;
  internalMessages?: true;
  lifecycleMessages?: boolean;
  poolId?: number;
  workerSlot?: number;
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
    /\.[cm]?[jt]s$/u,
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
    // SAFETY: The optional callback starts unset and only receives the typed observer below.
    gcObserver: undefined as
      | ((samples: GcSample[], thread: string, workerSlot?: number) => void)
      | undefined,
    revision: 0,
    nextPoolId: 0,
    poolIds: new WeakMap<object, number>(),
    workers: new Map<WorkerCpuHandle, WorkerSource>(),
    lifecycle: new Map<string, { started: number; retired: Map<WorkerRetirementReason, number> }>(),
  };
});

export function createCpuTrackedWorker(...args: ConstructorParameters<typeof Worker>): Worker {
  const worker = runWithMainThreadTask(
    `worker:${workerScriptName(args[0], args[1]?.eval)}`,
    () => new Worker(...args),
  );
  trackNativeWorkerForCpu(worker, args[0], args[1]?.eval);
  trackedWorkers.workers.get(worker)!.internalMessages = true;
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
  const source = trackedWorkers.workers.get(worker)!;
  source.script = workerScriptName(filename, evalSource);
  if (source.script === "code-mode-node.worker.js" && source.workerSlot === undefined) {
    // Reuse slots only after native exit; overflow keeps the script-level attribution.
    const occupied = new Set([...trackedWorkers.workers.values()].map((entry) => entry.workerSlot));
    for (let slot = 1; slot <= MAX_DIAGNOSTIC_WORKER_SLOTS; slot++) {
      if (!occupied.has(slot)) {
        source.workerSlot = slot;
        break;
      }
    }
  }
  // Heartbeat verification shares SQLite's id/ok reply shape; its owner identifies the protocol.
  source.lifecycleMessages =
    source.script === "openclaw-state-lease-heartbeat.worker.js" ||
    source.script === "gateway-state-owner-heartbeat.worker.js";
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

function canObserveWorkerMessages(worker: Worker): boolean {
  if (!Object.isExtensible(worker)) {
    return false;
  }
  for (const method of ["postMessage", "emit"]) {
    let owner: object | null = worker;
    while (owner) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, method);
      if (descriptor) {
        if (!descriptor.writable || typeof descriptor.value !== "function") {
          return false;
        }
        break;
      }
      owner = Reflect.getPrototypeOf(owner);
    }
    if (!owner) {
      return false;
    }
  }
  return true;
}

function trackWorker(worker: WorkerCpuHandle): void {
  if (trackedWorkers.workers.has(worker)) {
    return;
  }
  if (isMainThread && worker instanceof Worker) {
    // Worker construction clones startup data and inherited environment data once.
    recordWorkerMessage("lifecycle", "to_worker");
  }
  // Foreign Workers with accessor/read-only methods keep CPU/lifecycle coverage only.
  // Inspect descriptors once at registration; never invoke getters or setters for metrics.
  if (isMainThread && worker instanceof Worker && canObserveWorkerMessages(worker)) {
    // Per-instance hooks also cover plugin Workers, without adding a message listener
    // that would change native port reference semantics. Virtual retained handles
    // already observe their native task/control ports.
    const nativePrototype = Object.getPrototypeOf(worker) === Worker.prototype;
    const postMessage =
      // oxlint-disable-next-line typescript/unbound-method -- call preserves custom own/subclass methods and the receiver.
      !nativePrototype || Object.hasOwn(worker, "postMessage") ? worker.postMessage : undefined;
    worker.postMessage = function (value, transferList) {
      const bytes = source.internalMessages ? workerMessagePayloadBytes(value) : undefined;
      // oxlint-disable-next-line typescript/unbound-method -- Preserve later prototype instrumentation and the receiver.
      (postMessage ?? Worker.prototype.postMessage).call(this, value, transferList);
      if (source.lifecycleMessages) {
        recordWorkerMessage("lifecycle", "to_worker", bytes);
      } else if (source.internalMessages) {
        observeWorkerMessage(value, "to_worker", "other", bytes ?? null);
      } else {
        // Dependency payloads can have getters/proxies. Only native cloning may inspect them.
        recordWorkerMessage("other", "to_worker");
      }
    };
    // oxlint-disable-next-line typescript/unbound-method -- call preserves custom own/subclass methods and the receiver.
    const emit = !nativePrototype || Object.hasOwn(worker, "emit") ? worker.emit : undefined;
    worker.emit = function (this: Worker, event: string | symbol, ...args: unknown[]) {
      if (event === "message") {
        if (source.lifecycleMessages) {
          recordWorkerMessage("lifecycle", "from_worker", workerMessagePayloadBytes(args[0]));
        } else if (source.internalMessages) {
          observeWorkerMessage(args[0], "from_worker");
        } else {
          recordWorkerMessage("other", "from_worker");
        }
      }
      // oxlint-disable-next-line typescript/unbound-method -- Preserve later prototype instrumentation and the receiver.
      return (emit ?? Worker.prototype.emit).call(this, event, ...args);
    };
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

/** Heartbeat demand also applies to workers attaching after observer activation. */
export function setTrackedWorkerGcObserver(
  observer: ((samples: GcSample[], thread: string, workerSlot?: number) => void) | undefined,
): void {
  const wasEnabled = Boolean(trackedWorkers.gcObserver);
  trackedWorkers.gcObserver = observer;
  const enabled = Boolean(observer);
  if (wasEnabled !== enabled) {
    for (const source of trackedWorkers.workers.values()) {
      if (source.memoryPort) {
        source.memoryPort.postMessage({ gc: enabled }, []);
        recordWorkerMessage("memory", "to_worker", 1);
      }
    }
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
  port.on("message", (record: WorkerMemorySample | { gc: GcSample[] }) => {
    // Known numeric payload bytes; object envelopes and GC kind labels are excluded.
    recordWorkerMessage(
      "memory",
      "from_worker",
      ("heapUsed" in record ? 32 + (record.heapSizeLimitBytes === undefined ? 0 : 8) : 0) +
        (record.gc?.length ?? 0) * 8,
    );
    // This private port is handed off by our isolate telemetry owner, not task input.
    if (record.gc) {
      trackedWorkers.gcObserver?.(record.gc, source.script, source.workerSlot);
    }
    if (!("heapUsed" in record)) {
      return;
    }
    // The private producer supplies native counters; retain the cloned sample as-is.
    delete record.gc;
    source.heap = {
      value: record,
      sampledAt: performance.now(),
    };
    source.memoryPending = false;
    source.memoryUnavailable = false;
  });
  port.once("close", close);
  port.once("messageerror", close);
  port.unref();
  if (trackedWorkers.gcObserver) {
    port.postMessage({ gc: true });
    recordWorkerMessage("memory", "to_worker", 1);
  }
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
        workerSlot: source.workerSlot,
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
          recordWorkerMessage("memory", "to_worker", 0);
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
