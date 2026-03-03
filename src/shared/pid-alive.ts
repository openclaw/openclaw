import fsSync from "node:fs";

/**
 * Check if a process is a zombie on Linux by reading /proc/<pid>/status.
 * Returns false on non-Linux platforms or if the proc file can't be read.
 */
function isZombieProcess(pid: number): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  try {
    const status = fsSync.readFileSync(`/proc/${pid}/status`, "utf8");
    const stateMatch = status.match(/^State:\s+(\S)/m);
    return stateMatch?.[1] === "Z";
  } catch {
    return false;
  }
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (isZombieProcess(pid)) {
    return false;
  }
  return true;
}

let cachedBootId: string | null | undefined;

/**
 * Read the system boot ID on Linux (`/proc/sys/kernel/random/boot_id`).
 * Returns `null` on non-Linux platforms or if the file can't be read.
 * The value is cached for the lifetime of the process since it never changes
 * within a single boot.
 */
export function getSystemBootId(): string | null {
  if (cachedBootId !== undefined) {
    return cachedBootId;
  }
  if (process.platform !== "linux") {
    cachedBootId = null;
    return null;
  }
  try {
    cachedBootId = fsSync.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return cachedBootId;
  } catch {
    cachedBootId = null;
    return null;
  }
}

/**
 * Reset the cached boot ID. Only useful in tests.
 */
export function __resetBootIdCache(): void {
  cachedBootId = undefined;
}
