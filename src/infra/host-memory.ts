import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

/** Defer optional background work before consuming the last 20% of a process limit. */
export function isConstrainedProcessLowOnMemory(): boolean {
  const limit = process.constrainedMemory();
  return Number.isSafeInteger(limit) && limit > 0 && process.availableMemory() <= limit * 0.2;
}

const CGROUP_MOUNT = "/sys/fs/cgroup";

/**
 * Memory left under the Gateway's cgroup v2 limits: for its own cgroup and every visible ancestor
 * with a memory limit, the limit minus what the cgroup holds, smallest first. What a cgroup holds
 * counts every process in it, the Gateway's peers included, but not inactive file cache, which
 * the kernel reclaims before it would kill anything. Undefined when no limit is readable, as off
 * Linux, on cgroup v1, or without access to the cgroup files.
 */
export function readCgroupMemoryHeadroomBytes(): number | undefined {
  let relative: string | undefined;
  try {
    relative = /^0::(\/.*)$/mu.exec(fs.readFileSync("/proc/self/cgroup", "utf8"))?.[1];
  } catch {
    return undefined;
  }
  if (!relative) {
    return undefined;
  }
  let directory = path.resolve(CGROUP_MOUNT, `.${relative}`);
  if (directory !== CGROUP_MOUNT && !directory.startsWith(`${CGROUP_MOUNT}/`)) {
    return undefined;
  }
  let headroom: number | undefined;
  for (;;) {
    try {
      const limit = fs.readFileSync(path.join(directory, "memory.max"), "utf8").trim();
      if (/^\d+$/u.test(limit)) {
        const current = Number(fs.readFileSync(path.join(directory, "memory.current"), "utf8"));
        const stat = fs.readFileSync(path.join(directory, "memory.stat"), "utf8");
        const inactiveFile = Number(/^inactive_file (\d+)$/mu.exec(stat)?.[1] ?? 0);
        headroom = Math.min(headroom ?? Infinity, Number(limit) - (current - inactiveFile));
      }
    } catch {
      // A cgroup without memory files or one this process cannot read sets no limit here.
    }
    // A cgroup namespace can expose a constrained container at the mount root.
    if (directory === CGROUP_MOUNT) {
      return headroom;
    }
    directory = path.dirname(directory);
  }
}
