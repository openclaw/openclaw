import type { HeapSpaceInfo } from "node:v8";
import type { getSessionRowSelectionMetrics } from "./gateway-work-metrics.js";
import type { GcSample } from "./gc-observer.js";
import type { WorkerMessageMetric } from "./worker-message-metrics.js";
import type { WorkerPoolClass } from "./worker-pool-sizing.js";
import type { WorkerRequestKind } from "./worker-request-kind.js";

export type WorkerGcProfiles = { heap: string; cpu: string };

export type WorkerGcStorm = {
  workerId?: string;
  runId?: string;
  sessionKeyHash?: string;
  cellCount: number;
  activeCellCount: number;
  bridgeMethods: string[];
  majorCollections: number;
  intervalMs: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  heapSizeLimitBytes: number;
  captureStatus?: "requested" | "complete" | "unavailable";
  captureReason?: string;
  profiles?: WorkerGcProfiles;
};

export type WorkerMemorySample = Pick<
  NodeJS.MemoryUsage,
  "heapUsed" | "heapTotal" | "external" | "arrayBuffers"
> & {
  heapSizeLimitBytes?: number;
  oldGenerationAfterGcBytes?: number;
  heapSpaces?: NonNullable<DiagnosticMemoryUsage["workerHeaps"]>[number]["heapSpaces"];
  retainedData?: NonNullable<DiagnosticMemoryUsage["workerHeaps"]>[number]["retainedData"];
  gc?: GcSample[];
};

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
      type: "gateway.main_thread.stall";
      stalls: { task: string; durationMs: number }[];
      dropped: number;
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

export const DIAGNOSTIC_WORKER_RETAINED_STRUCTURES = [
  "catalog-config",
  "catalog-source",
  "catalog-entries",
  "catalog-index",
  "catalog-pricing",
  "catalog-request",
  "catalog-metadata",
  "catalog-static",
  "catalog-remote",
  "catalog-auth",
] as const;

/** Owner-reported size estimates only; never data keys, identities, or retained contents. */
export type DiagnosticWorkerRetainedData = {
  structure: (typeof DIAGNOSTIC_WORKER_RETAINED_STRUCTURES)[number];
  entries: number;
  approximateBytes: number;
  stringBytes?: number;
  objects?: number;
  generations?: number;
  providers?: number;
  accounts?: number;
  truncated?: boolean;
};

export type DiagnosticMemoryUsage = {
  rssBytes: number;
  /** Linux RssAnon: resident anonymous pages, including managed heaps and buffers. */
  anonymousRssBytes?: number;
  /** Linux VmSwap: swapped anonymous private pages, excluding shared-memory swap. */
  anonymousSwapBytes?: number;
  heapTotalBytes: number;
  heapUsedBytes: number;
  /** Actual main-isolate V8 limit; absent on runtimes without V8. */
  heapSizeLimitBytes?: number;
  /** old_space + large_object_space at the last observed native major-GC epilogue. */
  oldGenerationAfterGcBytes?: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  heapSpaces?: HeapSpaceInfo[];
  workerCount?: number;
  /** Live PostgreSQL bridges, including children of workers with diagnostic registration. */
  postgresBridgeCount?: number;
  /** Threads that started their own PostgreSQL pool without inherited endpoints. */
  postgresPoolSelfRootCount?: number;
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
    /** Node's finite native space set; absent for native-only fallback samples and Bun. */
    heapSpaces?: Pick<HeapSpaceInfo, "space_name" | "space_used_size">[];
    /** Approximate owner-held data, not V8 retained-size attribution or a heap snapshot. */
    retainedData?: readonly DiagnosticWorkerRetainedData[];
    /** Actual V8 isolate limit; unavailable on runtimes without V8. */
    heapSizeLimitBytes?: number;
    /** Absent until a major GC is observed, and for native-only fallback samples. */
    oldGenerationAfterGcBytes?: number;
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
  /** Process-lifetime pool totals; completed workers remain represented after native exit. */
  workerTaskMetrics?: {
    workerClass: WorkerPoolClass | "other";
    script: string;
    tasksCompleted: number;
    heapUsedHighWaterBytes: number;
    gc: { kind: GcSample["kind"]; count: number; durationMs: number; reclaimedBytes: number }[];
  }[];
  /** Main-thread transport totals; unknown payload sizes remain separate from known zero bytes. */
  workerMessages?: WorkerMessageMetric[];
  /** Process-lifetime selector totals with bounded shape and caller labels. */
  sessionRowSelections?: ReturnType<typeof getSessionRowSelectionMetrics>;
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
