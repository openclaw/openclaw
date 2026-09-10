import os from "node:os";

/**
 * Host memory that is free or reclaimable. libuv's free-memory reading counts only
 * free pages on Darwin, so idle Macs report nearly full memory; the available-memory
 * reading also counts inactive and purgeable pages. It reports 0 where unsupported.
 */
export function readHostFreeMemoryBytes(): number {
  const available = process.availableMemory();
  return available > 0 ? available : os.freemem();
}
