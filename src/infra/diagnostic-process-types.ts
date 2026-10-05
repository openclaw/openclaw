import type { HeapSpaceInfo } from "node:v8";

export type WorkerRequestKind =
  | "identity"
  | "avatar"
  | "catalog"
  | "transcript"
  | "sqlite_read"
  | "sqlite_writer"
  | "state_read"
  | "cron"
  | "compute"
  | "other";

export type DiagnosticWorkerRequestFields = {
  type: "worker.request";
  kind: WorkerRequestKind;
  requestClass: string;
  phase: "queued" | "started" | "completed";
  queueDepth: number;
  queueWaitMs?: number;
  durationMs?: number;
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
  /** Bounded Git owner/operation; unknown for unattributed Git and none for other families. */
  operation?: string;
  count: number;
  intervalMs: number;
};
