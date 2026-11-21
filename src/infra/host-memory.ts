import { readFileSync } from "node:fs";
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

/** Read cgroup-v2 limits through visible ancestors, including a namespaced mount root. */
export function readCgroupV2MemoryLimits(files: readonly string[]): Record<string, number> {
  const limits: Record<string, number> = {};
  if (process.platform !== "linux") {
    return limits;
  }
  let relative: string | undefined;
  try {
    relative = /^0::(\/.*)$/mu.exec(readFileSync("/proc/self/cgroup", "utf8"))?.[1];
  } catch {
    return limits;
  }
  if (!relative) {
    return limits;
  }
  const mount = "/sys/fs/cgroup";
  let directory = path.resolve(mount, `.${relative}`);
  if (directory !== mount && !directory.startsWith(`${mount}/`)) {
    return limits;
  }
  for (;;) {
    for (const file of files) {
      try {
        const value = readFileSync(path.join(directory, file), "utf8").trim();
        if (/^\d+$/u.test(value)) {
          limits[file] = Math.min(limits[file] ?? Infinity, Number(value));
        }
      } catch {
        // Missing controllers and inaccessible ancestors retain known limits.
      }
    }
    if (directory === mount) {
      return limits;
    }
    directory = path.dirname(directory);
  }
}

/** Hard memory allowance, not free memory or the cgroup's reclaim threshold. */
export function readEffectiveMemoryLimit() {
  const total = os.totalmem();
  const cgroup = readCgroupV2MemoryLimits(["memory.max"])["memory.max"];
  return {
    memoryLimitBytes: cgroup === undefined ? total : Math.min(total, cgroup),
    memoryLimitSource:
      cgroup !== undefined && cgroup <= total ? ("cgroup-v2" as const) : ("host" as const),
  };
}
