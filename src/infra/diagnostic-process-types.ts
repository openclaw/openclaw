export type DiagnosticMemoryUsage = {
  rssBytes: number;
  heapTotalBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  workerCount?: number;
  workerHeapSampledCount?: number;
  workerHeapTotalBytes?: number;
  workerHeapUsedBytes?: number;
  /** Live, fresh isolate samples; script is an allowlisted basename or "other". */
  workerHeaps?: { script: string; heapUsed: number; heapTotal: number }[];
};

export type DiagnosticChildProcessSpawnFields = {
  type: "diagnostic.child_process.spawn";
  family: string;
  count: number;
  intervalMs: number;
};
