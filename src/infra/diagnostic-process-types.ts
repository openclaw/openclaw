import type { HeapSpaceInfo } from "node:v8";
import type { GcSample } from "./gc-observer.js";
import type { WorkerMessageMetric } from "./worker-message-metrics.js";
import type { WorkerRequestKind } from "./worker-request-kind.js";

export type DiagnosticRuntimeMeasurementFields =
  | {
      type: "gateway.http.cancelled";
      source: "client" | "shutdown";
    }
  | {
      type: "gateway.event_loop.sample";
      intervalMs: number;
      delayMaxMs: number;
    }
  | {
      type: "diagnostic.gc";
      durationMs: number;
      /** Optional for existing SDK event producers; native observers always supply attribution. */
      kind?: GcSample["kind"];
      /** Bounded Node GC callback flags; absent or unrecognized values become other. */
      reason?: GcSample["reason"];
      /** main or an allowlisted worker script basename (other for unknown scripts). */
      thread?: string;
      /** Reusable Code Mode isolate slot (1–64), owned until native worker exit. */
      workerSlot?: number;
    };

export type DiagnosticWorkerRequestFields = {
  type: "worker.request";
  kind: WorkerRequestKind;
  requestClass: string;
  phase: "queued" | "started" | "completed";
  queueDepth: number;
  queueWaitMs?: number;
  durationMs?: number;
  /** Monotonic process timestamps spanning the complete request, including transport frames. */
  timing?: Partial<
    Record<
      | "enqueued"
      | "dispatched"
      | "posted"
      | "postFinished"
      | "received"
      | "inputReady"
      | "executeStarted"
      | "executeFinished"
      | "serialized"
      | "replied"
      | "replyReceived",
      number
    >
  >;
};

export type DiagnosticAsyncQueueDroppedFields = {
  type: "diagnostic.async_queue.dropped";
  droppedEvents: number;
  droppedTrustedEvents?: number;
  droppedUntrustedEvents?: number;
  droppedPriorityEvents?: number;
  queueLength: number;
  maxQueueLength: number;
  drainBatchSize: number;
};

export type DiagnosticMemoryUsage = {
  rssBytes: number;
  heapTotalBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  heapSpaces?: HeapSpaceInfo[];
  workerCount?: number;
  workerHeapSampledCount?: number;
  workerHeapTotalBytes?: number;
  workerHeapUsedBytes?: number;
  workerExternalBytes?: number;
  workerArrayBuffersBytes?: number;
  workerArrayBuffersSampledCount?: number;
  /** Coverage concerns direct Workers only; nested isolates are not in the parent registry. */
  workerMemoryScope?: "direct";
  workerMemoryCoverage?: "complete" | "partial" | "unavailable";
  workerMemoryMissing?: {
    script: string;
    threadId: number;
    reason: "pending" | "stale" | "unavailable";
  }[];
  /** Live, fresh isolate samples; script is an allowlisted basename or "other". */
  workerHeaps?: {
    script: string;
    heapUsed: number;
    heapTotal: number;
    /** Actual V8 isolate limit; unavailable on runtimes without V8. */
    heapSizeLimitBytes?: number;
    threadId?: number;
    /** Same bounded slot as diagnostic.gc; absent for overflow and other scripts. */
    workerSlot?: number;
    external?: number;
    /** Missing for native-only samplers; zero is a measured value. Included in external. */
    arrayBuffers?: number;
    sampleAgeMs?: number;
  }[];
  /** Cumulative process-owned counts; script and reason come from fixed allowlists. */
  workerLifecycle?: {
    script: string;
    started: number;
    retired: { reason: string; count: number }[];
  }[];
  /** Main-thread transport totals; unknown payload sizes remain separate from known zero bytes. */
  workerMessages?: WorkerMessageMetric[];
};

export const DIAGNOSTIC_MEMORY_PRESSURE_METRICS = [
  "thresholdBytes",
  "limitBytes",
  "usedBytes",
  "workerThreadId",
  "rssGrowthBytes",
  "windowMs",
] as const;

export type DiagnosticMemoryPressureMetrics = Partial<
  Record<(typeof DIAGNOSTIC_MEMORY_PRESSURE_METRICS)[number], number>
>;

export type DiagnosticMemoryPressureFields = DiagnosticMemoryPressureMetrics & {
  type: "diagnostic.memory.pressure";
  level: "warning" | "critical";
  reason: "rss_threshold" | "heap_threshold" | "worker_heap_threshold" | "rss_growth";
  memory: DiagnosticMemoryUsage;
};

export type DiagnosticChildProcessSpawnFields = {
  type: "diagnostic.child_process.spawn";
  family: string;
  /** Bounded Git owner or SQLite session/transport; unknown for unattributed Git. */
  operation?: string;
  count: number;
  intervalMs: number;
};
