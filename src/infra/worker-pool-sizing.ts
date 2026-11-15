import { availableParallelism } from "node:os";

export type WorkerPoolClass = "reader" | "file-reader" | "compute" | "writer" | "singleton";

export function resolveWorkerComputeLimit(): number {
  return Math.max(1, availableParallelism() - 1);
}

/** Size once at pool creation; serial owners must never inherit host CPU fanout. */
export function resolveWorkerPoolSize(kind: WorkerPoolClass): number {
  const cap = kind === "reader" || kind === "file-reader" ? 2 : kind === "compute" ? 4 : 1;
  return Math.min(cap, resolveWorkerComputeLimit());
}

export function resolveStateReadWorkerCount(): number {
  // A retained settlement read must leave capacity for a fresh catalog read before release.
  return Math.max(2, resolveWorkerPoolSize("reader"));
}

// These hosts multiplex independent database owners, never writers for the same database.
export const AGENT_DATABASE_PREFLIGHT_CONCURRENCY = 2;
export function resolveSqliteBrokerWorkerCount(): number {
  return 2;
}

// History and search retain the same bounded isolate budget as other readers.
export const SESSION_TRANSCRIPT_FOREGROUND_WORKERS = resolveWorkerPoolSize("reader");

/**
 * Per-worker V8 old-generation ceiling.
 *
 * Every worker thread is its own V8 isolate with its own heap, so this ceiling is
 * multiplied by the number of live workers. It used to be a literal
 * `maxOldGenerationSizeMb: 512` repeated at every worker creation site, so an
 * idle worker could retain up to half a gigabyte before V8 was forced to
 * collect, and the value could not be tuned per deployment.
 *
 * The default is sized from observed live worker heaps on a production gateway
 * (session transcript 79-86 MiB, sqlite store 88-92 MiB, state read 41 MiB,
 * sqlite archive 43-49 MiB) plus headroom for churn. Deployments that need more
 * can raise it with OPENCLAW_WORKER_HEAP_LIMIT_MB.
 *
 * V8 heap limits exclude ArrayBuffer/native allocations, so this is not an RSS
 * boundary; it bounds what a single idle worker can retain.
 */
export const DEFAULT_WORKER_HEAP_LIMIT_MB = 256;

/** Below this, real workloads OOM their worker. */
export const MIN_WORKER_HEAP_LIMIT_MB = 64;

/** Above this the ceiling stops being a bound. */
export const MAX_WORKER_HEAP_LIMIT_MB = 4096;

/**
 * Workers that hold a long-lived cache rather than a request-scoped working set
 * keep more: the model catalog worker keeps the whole catalog resident, so it
 * keeps a 512 MiB floor instead of inheriting the shared default.
 */
export const CACHED_WORKER_HEAP_FLOOR_MB = 512;

/** Resolve the shared per-worker ceiling, clamped to a sane range. */
export function resolveWorkerHeapLimitMb(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OPENCLAW_WORKER_HEAP_LIMIT_MB?.trim();
  if (!raw) {
    return DEFAULT_WORKER_HEAP_LIMIT_MB;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_WORKER_HEAP_LIMIT_MB;
  }
  return Math.min(MAX_WORKER_HEAP_LIMIT_MB, Math.max(MIN_WORKER_HEAP_LIMIT_MB, parsed));
}

/** Resolve the ceiling for workers that retain a long-lived cache. */
export function resolveCachedWorkerHeapLimitMb(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(CACHED_WORKER_HEAP_FLOOR_MB, resolveWorkerHeapLimitMb(env));
}

export function resolveUpdateHashWorkerCount(): number {
  // Bun/Linux reports host memory rather than the process's cgroup allowance.
  if (process.versions.bun && process.platform === "linux") {
    return 0;
  }
  const available = process.availableMemory();
  if (!Number.isSafeInteger(available) || available <= 0) {
    return 0;
  }
  // Reserve half for inventory growth and the parent, budgeting 256 MiB per isolate.
  return Math.max(
    0,
    Math.min(4, availableParallelism() - 1, Math.floor(available / 2 / (256 * 1024 * 1024))),
  );
}
