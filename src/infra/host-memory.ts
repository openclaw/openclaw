import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path/posix";
import { decodeMountInfoPath } from "@openclaw/normalization-core/mountinfo-path";

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

/** Defer optional background work before consuming the last 20% of process or host capacity. */
export function isMemoryPressureHigh(): boolean {
  const limit = process.constrainedMemory();
  if (
    Number.isSafeInteger(limit) &&
    limit > 0 &&
    readProcessAvailableMemoryBytes() <= limit * 0.2
  ) {
    return true;
  }
  // Node/Linux reports reclaimable host memory even without a process limit.
  // Other runtimes retain their process-limit policy; unknown host readings do not defer work.
  if (process.platform !== "linux" || process.versions.bun) {
    return false;
  }
  const free = readHostFreeMemoryBytes();
  return (free > 0 && free <= os.totalmem() * 0.2) || isCgroupV2AncestorPressured();
}

const CGROUP_V2_MOUNT = "/sys/fs/cgroup";

function readCgroupV2Membership(): string | undefined {
  try {
    return /^0::(\/.*)$/mu.exec(readFileSync("/proc/self/cgroup", "utf8"))?.[1];
  } catch {
    return undefined;
  }
}

/** Visible cgroup-v2 directories from this process's group up to the mount root. */
function listCgroupV2Directories(): string[] {
  if (process.platform !== "linux") {
    return [];
  }
  const relative = readCgroupV2Membership();
  if (!relative) {
    return [];
  }
  const directory = path.resolve(CGROUP_V2_MOUNT, `.${relative}`);
  if (directory !== CGROUP_V2_MOUNT && !directory.startsWith(`${CGROUP_V2_MOUNT}/`)) {
    return [];
  }
  return directoriesToMount(directory);
}

function directoriesToMount(start: string): string[] {
  let directory = start;
  const directories = [directory];
  while (directory !== CGROUP_V2_MOUNT) {
    directory = path.dirname(directory);
    directories.push(directory);
  }
  return directories;
}

// Optional work may only use charges proven to belong to the process's visible ancestry.
function readCgroupV2AncestorView() {
  const membership = readCgroupV2Membership();
  if (!membership || membership === "/" || membership.split("/").includes("..")) {
    return undefined;
  }
  const overmounts = new Set<string>();
  let directory: string;
  try {
    // A delegated mount can expose /pod at this path while membership still names
    // /pod/slice/service. A hidden, shadowed or unrelated view cannot identify our controllers.
    const views = [
      ...readFileSync("/proc/self/mountinfo", "utf8").matchAll(
        /^(\d+) (\d+) \d+:\d+ (\S+) (\/sys\/fs\/cgroup(?:\/\S*)?) .*? - (\S+) /gmu,
      ),
    ].map(([, id, parent, root, point, type]) => ({ id, parent, root, point, type }));
    // For stacked mounts, the visible one is not the parent mount of another at the same path.
    const atMount = views.filter(({ point }) => point === CGROUP_V2_MOUNT);
    const visible = atMount.filter(({ id }) => !atMount.some(({ parent }) => parent === id));
    const controller = visible.length === 1 ? visible[0] : undefined;
    if (!controller || controller.type !== "cgroup2") {
      return undefined;
    }
    const root = decodeMountInfoPath(controller.root!);
    const relative = path.relative(root, membership);
    if (
      !root.startsWith("/") ||
      root.split("/").includes("..") ||
      relative.split("/")[0] === ".."
    ) {
      return undefined;
    }
    directory = path.join(CGROUP_V2_MOUNT, relative);
    if (directory === CGROUP_V2_MOUNT) {
      return undefined;
    }
    directory = path.dirname(directory);
    for (const { parent, point } of views) {
      // A mount attached to a hidden lower view cannot cover the selected controller.
      if (parent !== controller.id || point === CGROUP_V2_MOUNT) {
        continue;
      }
      const child = decodeMountInfoPath(point!);
      overmounts.add(child);
      // Mask only the covered subtree. A parent can still cap the Gateway when
      // its service leaf or one controller file is overmounted.
      if (directory === child || directory.startsWith(`${child}/`)) {
        directory = path.dirname(child);
      }
    }
  } catch {
    return undefined;
  }
  return { directories: directoriesToMount(directory), overmounts };
}

function readCgroupV2File(
  directory: string,
  file: string,
  overmounts?: ReadonlySet<string>,
): string | undefined {
  const pathname = path.join(directory, file);
  if (overmounts?.has(pathname)) {
    return undefined;
  }
  try {
    return readFileSync(pathname, "utf8");
  } catch {
    // Missing controllers and inaccessible ancestors retain known limits.
    return undefined;
  }
}

function readCgroupV2Number(
  directory: string,
  file: string,
  overmounts?: ReadonlySet<string>,
): number | undefined {
  const value = readCgroupV2File(directory, file, overmounts)?.trim();
  return value !== undefined && /^\d+$/u.test(value) ? Number(value) : undefined;
}

/** Read cgroup-v2 limits through visible ancestors, including a namespaced mount root. */
export function readCgroupV2MemoryLimits(files: readonly string[]): Record<string, number> {
  const limits: Record<string, number> = {};
  for (const directory of listCgroupV2Directories()) {
    for (const file of files) {
      const value = readCgroupV2Number(directory, file);
      if (value !== undefined) {
        limits[file] = Math.min(limits[file] ?? Infinity, value);
      }
    }
  }
  return limits;
}

/** The visible cgroup whose memory.max is the effective hard limit, if any. */
export function findCgroupV2MemoryLimitDirectory(): string | undefined {
  let found: { directory: string; limit: number } | undefined;
  for (const directory of listCgroupV2Directories()) {
    const limit = readCgroupV2Number(directory, "memory.max");
    if (limit !== undefined && (!found || limit < found.limit)) {
      found = { directory, limit };
    }
  }
  return found?.directory;
}

// Node's native check covers the leaf. Sibling usage belongs to each shared ancestor,
// so compare its own charge with its own reclaim or hard limit.
function isCgroupV2AncestorPressured(): boolean {
  const view = readCgroupV2AncestorView();
  return (
    view?.directories.some((directory) => {
      const limit = Math.min(
        readCgroupV2Number(directory, "memory.high", view.overmounts) ?? Infinity,
        readCgroupV2Number(directory, "memory.max", view.overmounts) ?? Infinity,
      );
      if (!Number.isFinite(limit)) {
        return false;
      }
      const threshold = limit * 0.8;
      const current = readCgroupV2Number(directory, "memory.current", view.overmounts);
      // Reading memory.stat is unnecessary when even the full charge is below the threshold.
      return (
        current !== undefined &&
        current >= threshold &&
        cgroupV2WorkingSetBytes(directory, current, view.overmounts) >= threshold
      );
    }) ?? false
  );
}

function cgroupV2WorkingSetBytes(
  directory: string,
  current: number,
  overmounts?: ReadonlySet<string>,
): number {
  // Without memory.stat, the whole charge counts as working set.
  const stat = readCgroupV2File(directory, "memory.stat", overmounts);
  const inactiveFile = Number(stat?.match(/^inactive_file (\d+)$/mu)?.[1] ?? 0);
  return Math.max(0, current - inactiveFile);
}

/**
 * memory.current minus inactive file cache: the part of the cgroup charge the kernel
 * cannot cheaply reclaim. Active file cache still counts, so this overstates anon use.
 */
export function readCgroupV2WorkingSetBytes(directory: string): number | undefined {
  const current = readCgroupV2Number(directory, "memory.current");
  return current === undefined ? undefined : cgroupV2WorkingSetBytes(directory, current);
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
