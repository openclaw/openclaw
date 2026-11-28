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

let pressureCgroup: { membership: string; view: ReturnType<typeof readCgroupV2View> } | undefined;

/** Defer optional background work before consuming the last 20% of process or host capacity. */
export function isMemoryPressureHigh(): boolean {
  const linuxNode = process.platform === "linux" && !process.versions.bun;
  const membership = linuxNode ? readCgroupV2Membership() : undefined;
  // A live move via cgroup.procs changes the leaf and its ancestors.
  if (membership && pressureCgroup?.membership !== membership) {
    pressureCgroup = { membership, view: readCgroupV2View(membership) };
  }
  const view = membership ? pressureCgroup?.view : undefined;
  const delegated = view?.delegated ? readDelegatedMemory(view) : undefined;
  const limit = delegated ? delegated.limitBytes : process.constrainedMemory();
  if (Number.isSafeInteger(limit) && limit > 0) {
    const available = delegated ? delegated.availableBytes : readProcessAvailableMemoryBytes();
    if (available !== undefined && available <= limit * 0.2) {
      return true;
    }
  }
  if (!linuxNode) {
    return false;
  }
  const free = readHostFreeMemoryBytes();
  return (free > 0 && free <= os.totalmem() * 0.2) || isCgroupV2AncestorPressured(view);
}

const CGROUP_V2_MOUNT = "/sys/fs/cgroup";

function readCgroupV2Membership(): string | undefined {
  try {
    return /^0::(\/.*)$/mu.exec(readFileSync("/proc/self/cgroup", "utf8"))?.[1];
  } catch {
    return undefined;
  }
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

/** Map namespace-relative membership through the visible cgroup2 mount before reading any limits. */
function readCgroupV2View(
  membership = process.platform === "linux" ? readCgroupV2Membership() : undefined,
) {
  if (!membership) {
    return undefined;
  }
  const overmounts = new Set<string>();
  let mountinfo: string;
  try {
    mountinfo = readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    // Restricted procfs still permits the historical hard-limit read. Optional
    // work needs a verified ancestor charge before it can use this view.
    if (membership.split("/").includes("..")) {
      return undefined;
    }
    const leaf = path.resolve(CGROUP_V2_MOUNT, `.${membership}`);
    return {
      leaf,
      directories: directoriesToMount(leaf),
      overmounts,
      verified: false,
      delegated: false,
    };
  }
  const views = [
    ...mountinfo.matchAll(
      /^(\d+) (\d+) (\d+:\d+) (\S+) (\/sys\/fs\/cgroup(?:\/\S*)?) .*? - (\S+) /gmu,
    ),
  ].map(([, id, parent, device, root, point, type]) => ({
    id,
    parent,
    device,
    root: decodeMountInfoPath(root!),
    point: decodeMountInfoPath(point!),
    type,
  }));
  const atMount = views.filter(({ point }) => point === CGROUP_V2_MOUNT);
  const visible = atMount.filter(({ id }) => !atMount.some(({ parent }) => parent === id));
  const controller = visible.length === 1 ? visible[0] : undefined;
  if (
    !controller ||
    controller.type !== "cgroup2" ||
    !controller.root.startsWith("/") ||
    controller.root.split("/").includes("..")
  ) {
    return undefined;
  }
  const relative = path.relative(controller.root, membership);
  const delegated = controller.root !== "/";
  if (membership.split("/").includes("..") || relative.split("/")[0] === "..") {
    // A delegated mount is identifiable even when this membership lies outside it.
    return { leaf: undefined, directories: [], overmounts, verified: true, delegated };
  }
  const leaf = path.join(CGROUP_V2_MOUNT, relative);
  const directories = directoriesToMount(leaf);
  // An identity-preserving bind still exposes the same cgroup. Follow its
  // child mounts too; other binds can hide one controller file or a whole subtree.
  const visibleParents = [controller];
  for (const current of visibleParents) {
    const children = views.filter(({ parent, id }) => parent === current.id && id !== current.id);
    const points = new Set(children.map(({ point }) => point));
    for (const child of children) {
      // A nonrecursive bind hides older submounts below it. Visible submounts
      // attach to the new mount ID, not its parent in the lower view.
      if (
        directoriesToMount(child.point)
          .slice(1)
          .some((ancestor) => points.has(ancestor))
      ) {
        continue;
      }
      const expected = path.join(controller.root, path.relative(CGROUP_V2_MOUNT, child.point));
      if (
        child.type === "cgroup2" &&
        child.device === controller.device &&
        child.root === expected
      ) {
        visibleParents.push(child);
      } else {
        overmounts.add(child.point);
      }
    }
  }
  return {
    leaf,
    directories: directories.slice(
      directories.findLastIndex((directory) => overmounts.has(directory)) + 1,
    ),
    overmounts,
    verified: true,
    delegated,
  };
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

// libuv 1.52.1 began including the two soft rlimits in constrainedMemory(), but not in
// availableMemory(). Read them independently: the native combined result may belong to a decoy.
function readLibuvMemoryRlimit() {
  const [major = 0, minor = 0, patch = 0] = process.versions.uv.split(".").map(Number);
  let limit = Infinity;
  if (major < 1 || (major === 1 && (minor < 52 || (minor === 52 && patch < 1)))) {
    return limit;
  }
  try {
    const limits = readFileSync("/proc/self/limits", "utf8");
    for (const match of limits.matchAll(/^Max (?:address space|data size)\s+(\d+)\s+/gmu)) {
      const soft = Number(match[1]);
      if (Number.isSafeInteger(soft) && soft > 0) {
        limit = Math.min(limit, soft);
      }
    }
  } catch {
    // Restricted procfs cannot establish a process-specific soft limit.
  }
  return limit;
}

function readDelegatedCgroupMemory(view: ReturnType<typeof readCgroupV2View>) {
  const leaf =
    view?.verified && view.leaf && view.directories.includes(view.leaf) ? view.leaf : undefined;
  const high = leaf && readCgroupV2File(leaf, "memory.high", view?.overmounts)?.trim();
  const max = leaf && readCgroupV2File(leaf, "memory.max", view?.overmounts)?.trim();
  const limits = [high, max].map((value) =>
    value === "max" ? Infinity : value && /^\d+$/u.test(value) ? Number(value) : undefined,
  );
  const limitBytes = Math.min(...limits.map((limit) => limit ?? Infinity));
  let availableBytes: number | undefined;
  // Node counts raw charges, including file cache. An obscured counter gives no
  // remaining allowance; never substitute the unstripped path or a sibling here.
  if (leaf && limits.every((limit) => limit !== undefined) && limitBytes > 0) {
    if (limitBytes > os.totalmem()) {
      availableBytes = os.freemem();
    } else {
      const current = readCgroupV2Number(leaf, "memory.current", view?.overmounts);
      if (current !== undefined) {
        availableBytes = Math.max(0, limitBytes - current);
      }
    }
  }
  return { limitBytes: limitBytes || Infinity, availableBytes };
}

function readDelegatedMemory(view: ReturnType<typeof readCgroupV2View>) {
  const { limitBytes, availableBytes } = readDelegatedCgroupMemory(view);
  return { limitBytes: Math.min(limitBytes, readLibuvMemoryRlimit()), availableBytes };
}

function startsInDelegatedNodeCgroup() {
  return process.platform === "linux" && !process.versions.bun && readCgroupV2View()?.delegated;
}

/** Ordinary schedulers keep the native read. Delegated schedulers recheck membership and masks. */
export function captureServiceAvailableMemoryReader(): () => number | undefined {
  if (!startsInDelegatedNodeCgroup()) {
    return () => process.availableMemory();
  }
  return () => {
    const view = readCgroupV2View();
    return view?.verified && !view.delegated
      ? process.availableMemory()
      : readDelegatedCgroupMemory(view).availableBytes;
  };
}

/** Ordinary startup mounts keep the native tick. Delegated ticks recheck membership and masks. */
export function captureDelegatedMemoryPressureReader() {
  if (startsInDelegatedNodeCgroup()) {
    return () => readDelegatedMemory(readCgroupV2View());
  }
  return undefined;
}

/** Read cgroup-v2 limits through visible ancestors, including a namespaced mount root. */
export function readCgroupV2MemoryLimits(files: readonly string[]): Record<string, number> {
  const limits: Record<string, number> = {};
  const view = readCgroupV2View();
  for (const directory of view?.directories ?? []) {
    for (const file of files) {
      const value = readCgroupV2Number(directory, file, view?.overmounts);
      if (value !== undefined) {
        limits[file] = Math.min(limits[file] ?? Infinity, value);
      }
    }
  }
  return limits;
}

/** The budget samples the same visible controller that supplied its hard limit. */
export function captureCgroupV2WorkingSetReader(): (() => number | undefined) | undefined {
  const view = readCgroupV2View();
  if (!view) {
    return undefined;
  }
  let found: { directory: string; limit: number } | undefined;
  for (const directory of view.directories) {
    const limit = readCgroupV2Number(directory, "memory.max", view.overmounts);
    if (limit !== undefined && (!found || limit < found.limit)) {
      found = { directory, limit };
    }
  }
  if (!found) {
    return undefined;
  }
  const { directory } = found;
  return () => {
    const current = readCgroupV2Number(directory, "memory.current", view.overmounts);
    return current === undefined
      ? undefined
      : cgroupV2WorkingSetBytes(directory, current, view.overmounts);
  };
}

// The process pressure reader covers the leaf. Sibling usage belongs to each shared ancestor,
// so compare its own charge with its own reclaim or hard limit.
function isCgroupV2AncestorPressured(view: ReturnType<typeof readCgroupV2View>): boolean {
  if (!view?.verified) {
    return false;
  }
  return view.directories.some((directory) => {
    if (directory === view.leaf) {
      return false;
    }
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
  });
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
