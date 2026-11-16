import os from "node:os";

/**
 * Host memory that is free or reclaimable. On macOS, Node's available-memory
 * reading includes inactive and purgeable pages, unlike os.freemem(); other
 * platforms retain the host-wide os.freemem() reading.
 */
export function readHostFreeMemoryBytes(): number {
  if (process.platform !== "darwin") {
    return os.freemem();
  }
  const available = process.availableMemory();
  return available > 0 ? available : os.freemem();
}

/** Defer optional background work before consuming the last 20% of process or host capacity. */
export function isMemoryPressureHigh(): boolean {
  const limit = process.constrainedMemory();
  if (Number.isSafeInteger(limit) && limit > 0 && process.availableMemory() <= limit * 0.2) {
    return true;
  }
  // Linux Node reports reclaimable host memory even when the process has no memory limit.
  if (process.platform !== "linux" || process.versions.bun) {
    return false;
  }
  const free = readHostFreeMemoryBytes();
  return free > 0 && free <= os.totalmem() * 0.2;
}
