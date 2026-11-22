import type { Worker } from "node:worker_threads";
import type { WorkerGcStorm, WorkerMemorySample } from "./diagnostic-process-types.js";
import type { GcSample } from "./gc-observer.js";
import type { SqliteReaderCounter } from "./sqlite-reader-metrics.js";
import type { PostgresBridgeCounter } from "./worker-postgres-bridge-census.js";

export type WorkerCpuHandle = {
  readonly threadId: number;
  cpuUsage: Worker["cpuUsage"];
  getHeapStatistics: Worker["getHeapStatistics"];
  once(event: "exit", listener: () => void): unknown;
};

export type WorkerMemoryMessage =
  | WorkerMemorySample
  | { flushed: true; heapUsed: number }
  | { gc: GcSample[] }
  | { gcStorm: WorkerGcStorm }
  | { postgresBridgeCounters: PostgresBridgeCounter[] }
  | { sqliteReaderCounter: SqliteReaderCounter }
  | { retireWorkerId: string };
