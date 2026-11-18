import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

// <mach/host_info.h>: HOST_VM_INFO returns vm_statistics_data_t, 14 natural_t counters.
const HOST_VM_INFO = 2;
const HOST_VM_INFO_COUNT = 14;
const FREE_COUNT_INDEX = 0;
const INACTIVE_COUNT_INDEX = 2;
const PURGEABLE_COUNT_INDEX = 12;

type MachVmSymbols = {
  mach_host_self: () => number;
  host_statistics: (host: number, flavor: number, info: Uint32Array, count: Uint32Array) => number;
  getpagesize: () => number;
};

// Bound once per process; every reading queries the kernel.
let machVmSymbols: MachVmSymbols | undefined;

/**
 * Node's macOS reading (libuv uv_get_available_memory): free, inactive and purgeable
 * pages. Bun's process.availableMemory() on macOS returns free pages only.
 */
function readMachAvailableMemoryBytes(): number {
  if (!machVmSymbols) {
    // SAFETY: Bun's built-in FFI binds only these libSystem Mach VM statistics calls.
    const ffi = createRequire(import.meta.url)("bun:ffi") as {
      dlopen(
        path: string,
        symbols: Record<string, { args: string[]; returns: string }>,
      ): { symbols: MachVmSymbols };
    };
    machVmSymbols = ffi.dlopen("/usr/lib/libSystem.B.dylib", {
      mach_host_self: { args: [], returns: "u32" },
      host_statistics: { args: ["u32", "i32", "ptr", "ptr"], returns: "i32" },
      getpagesize: { args: [], returns: "i32" },
    }).symbols;
  }
  const counters = new Uint32Array(HOST_VM_INFO_COUNT);
  const count = new Uint32Array([HOST_VM_INFO_COUNT]);
  if (
    machVmSymbols.host_statistics(machVmSymbols.mach_host_self(), HOST_VM_INFO, counters, count) !==
    0
  ) {
    return 0;
  }
  return (
    (counters[FREE_COUNT_INDEX]! +
      counters[INACTIVE_COUNT_INDEX]! +
      counters[PURGEABLE_COUNT_INDEX]!) *
    machVmSymbols.getpagesize()
  );
}

/** process.availableMemory(), with Node's reclaimable-memory semantics on macOS under Bun. */
export function readProcessAvailableMemoryBytes(): number {
  return process.platform === "darwin" && process.versions.bun
    ? readMachAvailableMemoryBytes()
    : process.availableMemory();
}

/**
 * Host memory that is free or reclaimable. On macOS, the available-memory reading
 * includes inactive and purgeable pages, unlike os.freemem(); other platforms
 * retain the host-wide os.freemem() reading.
 */
export function readHostFreeMemoryBytes(): number {
  if (process.platform !== "darwin") {
    return os.freemem();
  }
  const available = readProcessAvailableMemoryBytes();
  return available > 0 ? available : os.freemem();
}

/** Defer optional background work before consuming the last 20% of a process limit. */
export function isConstrainedProcessLowOnMemory(): boolean {
  const limit = process.constrainedMemory();
  return (
    Number.isSafeInteger(limit) && limit > 0 && readProcessAvailableMemoryBytes() <= limit * 0.2
  );
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
