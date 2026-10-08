import { availableParallelism } from "node:os";

export type WorkerPoolClass = "reader" | "file-reader" | "compute" | "writer" | "singleton";

export function resolveWorkerComputeLimit(): number {
  return Math.max(1, availableParallelism() - 1);
}

/** Size once at pool creation; serial owners must never inherit host CPU fanout. */
export function resolveWorkerPoolSize(kind: WorkerPoolClass): number {
  // Small file reads saturate before additional isolates repay their heap/transfer cost.
  const cap = kind === "reader" ? 8 : kind === "file-reader" ? 2 : kind === "compute" ? 4 : 1;
  return Math.min(cap, resolveWorkerComputeLimit());
}

export function resolveStateReadWorkerCount(): number {
  // A retained settlement read must leave capacity for a fresh catalog read before release.
  return Math.max(2, resolveWorkerPoolSize("reader"));
}

// These hosts multiplex independent database owners, never writers for the same database.
export const AGENT_DATABASE_PREFLIGHT_CONCURRENCY = 2;
export function resolveSqliteBrokerWorkerCount(): number {
  return Math.min(8, Math.max(2, Math.floor(availableParallelism() / 8)));
}

// Foreground history and context divide the same CPU headroom between two pools.
export const SESSION_TRANSCRIPT_FOREGROUND_WORKERS = Math.min(
  8,
  Math.ceil(resolveWorkerComputeLimit() / 2),
);

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
