// Field shapes carried by liveness warnings and queue samples. Kept apart from the
// event union so the continuation queue metrics and phase snapshots can be shared
// by samplers without importing the diagnostic event bus.

export type DiagnosticLivenessWarningReason = "event_loop_delay" | "event_loop_utilization" | "cpu";

export type DiagnosticPhaseDetails = Record<string, string | number | boolean>;

export type DiagnosticPhaseSnapshot = {
  name: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  cpuUserMs?: number;
  cpuSystemMs?: number;
  cpuTotalMs?: number;
  cpuCoreRatio?: number;
  details?: DiagnosticPhaseDetails;
};

export type DiagnosticContinuationQueueOwnerSample = {
  sessionKey: string;
  pendingQueued: number;
  pendingRunnable: number;
  pendingScheduled: number;
  stagedPostCompaction: number;
  invalidQueued: number;
  totalQueued: number;
  oldestQueuedAgeMs?: number;
  newestQueuedAgeMs?: number;
};

export type DiagnosticContinuationQueueHistoryPoint = {
  sampledAt: number;
  intervalMs?: number;
  totalQueued: number;
  pendingRunnable: number;
  pendingScheduled: number;
  stagedPostCompaction: number;
  invalidQueued: number;
  enqueued: number;
  drained: number;
  failed: number;
};

export type DiagnosticContinuationQueueMetrics = {
  sampledAt: number;
  intervalMs?: number;
  totalQueued: number;
  pendingQueued: number;
  pendingRunnable: number;
  pendingScheduled: number;
  stagedPostCompaction: number;
  invalidQueued: number;
  enqueuedSinceLastSample: number;
  drainedSinceLastSample: number;
  failedSinceLastSample: number;
  enqueueRatePerMinute?: number;
  drainRatePerMinute?: number;
  failedRatePerMinute?: number;
  topQueues: DiagnosticContinuationQueueOwnerSample[];
  queueDepthHistory: DiagnosticContinuationQueueHistoryPoint[];
};
