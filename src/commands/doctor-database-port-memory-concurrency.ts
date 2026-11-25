import { readHostFreeMemoryBytes } from "../infra/host-memory.js";
import { resolveWorkerPoolSize } from "../infra/worker-pool-sizing.js";

// One rebuild holds a memory manager, its chunk batches, and embedding responses.
const MEMORY_REBUILD_BUDGET_BYTES = 512 * 1024 * 1024;

/** Independent agent memory rebuilds share the host; small or busy hosts stay sequential. */
export function resolveMemoryRebuildConcurrency(): number {
  // Reserve half of free memory for the database engine and the command itself.
  const byMemory = Math.floor(readHostFreeMemoryBytes() / 2 / MEMORY_REBUILD_BUDGET_BYTES);
  return Math.max(1, Math.min(resolveWorkerPoolSize("compute"), byMemory));
}
