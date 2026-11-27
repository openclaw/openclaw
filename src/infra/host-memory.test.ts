import * as fs from "node:fs";
import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildPreparedCliRunContext } from "../agents/cli-runner.test-helpers.js";
import { ensureCliLiveSessionMemory } from "../agents/cli-runner/cli-live-session-registry.js";
import {
  captureCgroupV2WorkingSetReader,
  captureDelegatedMemoryPressureReader,
  captureServiceAvailableMemoryReader,
  readCgroupV2MemoryLimits,
  readEffectiveMemoryLimit,
  readHostFreeMemoryBytes,
  readProcessAvailableMemoryBytes,
} from "./host-memory.js";
import { resolveUpdateHashWorkerCount } from "./worker-pool-sizing.js";

const PAGE_BYTES = 16 * 1024;
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
// vm_statistics_data_t counters reported by the simulated macOS kernel.
const mach = vi.hoisted(() => ({ free: 0, inactive: 0, purgeable: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

function mockCgroupFiles(files: Map<string, string> = new Map()) {
  return vi
    .spyOn(fs, "readFileSync")
    .mockClear()
    .mockImplementation((path) => {
      const contents = files.get(String(path));
      if (contents === undefined) {
        throw new Error("controller unavailable");
      }
      return contents;
    });
}

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  const createRequire = (...args: Parameters<typeof actual.createRequire>) => {
    const require = actual.createRequire(...args);
    return Object.assign((specifier: string) => {
      if (specifier !== "bun:ffi") {
        return require(specifier);
      }
      return {
        dlopen: () => ({
          symbols: {
            mach_host_self: () => 1,
            getpagesize: () => PAGE_BYTES,
            host_statistics: (_host: number, _flavor: number, info: Uint32Array) => {
              info[0] = mach.free;
              info[2] = mach.inactive;
              info[12] = mach.purgeable;
              return 0;
            },
          },
        }),
      };
    }, require);
  };
  return new Proxy(actual, {
    get: (target, property, receiver) =>
      property === "createRequire" ? createRequire : Reflect.get(target, property, receiver),
  });
});

function setMachMemory(params: { free: number; inactive: number; purgeable: number }) {
  mach.free = params.free / PAGE_BYTES;
  mach.inactive = params.inactive / PAGE_BYTES;
  mach.purgeable = params.purgeable / PAGE_BYTES;
}

const bunVersion = Object.getOwnPropertyDescriptor(process.versions, "bun");

let isMemoryPressureHigh: typeof import("./host-memory.js").isMemoryPressureHigh;

async function loadMemoryPressureCheck() {
  vi.resetModules();
  return (await import("./host-memory.js")).isMemoryPressureHigh;
}

beforeEach(async () => {
  isMemoryPressureHigh = await loadMemoryPressureCheck();
  // Bun on macOS: availableMemory() equals freemem() and constrainedMemory() is physical RAM.
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  Object.defineProperty(process.versions, "bun", { configurable: true, value: "1.4.4" });
  vi.spyOn(process, "availableMemory").mockReturnValue(512 * MiB);
  vi.spyOn(os, "freemem").mockReturnValue(512 * MiB);
  vi.spyOn(process, "constrainedMemory").mockReturnValue(48 * GiB);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (bunVersion) {
    Object.defineProperty(process.versions, "bun", bunVersion);
  } else {
    delete (process.versions as { bun?: string }).bun;
  }
});

it("reads reclaimable memory from Mach VM statistics under Bun on macOS", () => {
  setMachMemory({ free: 512 * MiB, inactive: 16 * GiB, purgeable: 2 * GiB });
  const reclaimable = 512 * MiB + 18 * GiB;

  expect(readProcessAvailableMemoryBytes()).toBe(reclaimable);
  expect(readHostFreeMemoryBytes()).toBe(reclaimable);
  expect(isMemoryPressureHigh()).toBe(false);
  expect(resolveUpdateHashWorkerCount()).toBe(Math.min(4, os.availableParallelism() - 1));
});

it("still reports genuinely low macOS memory under Bun", () => {
  setMachMemory({ free: 128 * MiB, inactive: 128 * MiB, purgeable: 0 });

  expect(readHostFreeMemoryBytes()).toBe(256 * MiB);
  expect(isMemoryPressureHigh()).toBe(true);
  expect(resolveUpdateHashWorkerCount()).toBe(0);
});

it("keeps Node's own macOS available-memory reading and its free-memory fallback", () => {
  delete (process.versions as { bun?: string }).bun;
  const availableMemory = vi.spyOn(process, "availableMemory").mockReturnValue(20 * GiB);
  setMachMemory({ free: 0, inactive: 0, purgeable: 0 });

  expect(readHostFreeMemoryBytes()).toBe(20 * GiB);
  availableMemory.mockReturnValue(0);
  expect(readHostFreeMemoryBytes()).toBe(512 * MiB);
});

it("admits a CLI live session under Bun on macOS unless reclaimable memory is low", async () => {
  const context = buildPreparedCliRunContext({ provider: "claude-cli", sessionId: "bun-macos" });
  const signal = new AbortController().signal;

  setMachMemory({ free: 512 * MiB, inactive: 16 * GiB, purgeable: 2 * GiB });
  await expect(ensureCliLiveSessionMemory(context, signal)).resolves.toBeUndefined();

  setMachMemory({ free: 128 * MiB, inactive: 128 * MiB, purgeable: 0 });
  await expect(ensureCliLiveSessionMemory(context, signal)).rejects.toMatchObject({
    code: "cli_live_session_host_memory",
  });
});

it.each([
  [0, 0, false],
  [2 ** 64, 0, false],
  [1000, 201, false],
  [1000, 200, true],
])(
  "defers optional work in the last fifth of a process limit (limit: %d, available: %d)",
  (limit, available, low) => {
    mockCgroupFiles();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(process, "constrainedMemory").mockReturnValue(limit);
    vi.spyOn(process, "availableMemory").mockReturnValue(available);

    expect(isMemoryPressureHigh()).toBe(low);
  },
);

it.each([
  { name: "unbounded host", limit: 0, free: 40 * MiB, expected: true },
  { name: "unlimited sentinel", limit: 2 ** 64, free: 40 * MiB, expected: true },
  { name: "host pressure with process headroom", limit: GiB, free: 40 * MiB, expected: true },
  { name: "exhausted process allowance", limit: GiB, available: 0, expected: true },
  { name: "idle reclaimable host", limit: 0, free: 200 * MiB, expected: false },
  {
    name: "large host below the same threshold",
    limit: 0,
    free: 200 * GiB,
    total: 1024 * GiB,
    expected: true,
  },
  { name: "host at the threshold", limit: 0, free: 200, total: 1000, expected: true },
  { name: "host above the threshold", limit: 0, free: 201, total: 1000, expected: false },
  { name: "unknown host headroom", limit: 0, free: 0, expected: false },
  { name: "unknown host capacity", limit: 0, free: 40 * MiB, total: 0, expected: false },
  {
    name: "non-Linux host",
    limit: 0,
    free: 40 * MiB,
    platform: "win32" as const,
    expected: false,
  },
  { name: "Bun host", limit: 0, free: 40 * MiB, bun: "1.4.4", expected: false },
  { name: "Bun process pressure", limit: GiB, available: 0, bun: "1.4.4", expected: true },
])("detects $name without changing process-limit policy", (sample) => {
  mockCgroupFiles();
  vi.spyOn(process, "platform", "get").mockReturnValue(sample.platform ?? "linux");
  Object.defineProperty(process.versions, "bun", { configurable: true, value: sample.bun });
  vi.spyOn(process, "constrainedMemory").mockReturnValue(sample.limit);
  vi.spyOn(process, "availableMemory").mockReturnValue(sample.available ?? GiB);
  // Node/Linux os.freemem() exposes MemAvailable, including reclaimable pages, not MemFree.
  vi.spyOn(os, "freemem").mockReturnValue(sample.free ?? 200 * MiB);
  vi.spyOn(os, "totalmem").mockReturnValue(sample.total ?? 353 * MiB);

  expect(isMemoryPressureHigh()).toBe(sample.expected);
});

it.each([0, 1000])("tracks sibling pressure with native leaf limit %i", (leafLimit) => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  delete (process.versions as { bun?: string }).bun;
  vi.spyOn(process, "constrainedMemory").mockReturnValue(leafLimit);
  vi.spyOn(process, "availableMemory").mockReturnValue(900);
  vi.spyOn(os, "freemem").mockReturnValue(8 * GiB);
  vi.spyOn(os, "totalmem").mockReturnValue(16 * GiB);

  const parent = "/sys/fs/cgroup/pod";
  const files = new Map([
    ["/proc/self/cgroup", "0::/pod/service/gateway"],
    ["/proc/self/mountinfo", "30 1 0:27 / /sys/fs/cgroup rw - cgroup2 cgroup rw"],
    [`${parent}/memory.max`, "2000"],
    [`${parent}/memory.high`, "max"],
    [`${parent}/memory.current`, "1599"],
    [`${parent}/memory.stat`, "inactive_file 200"],
  ]);
  const read = mockCgroupFiles(files);
  // The intermediate service controller is unreadable. The next visible ancestor still counts.
  expect(isMemoryPressureHigh()).toBe(false);
  expect(read).not.toHaveBeenCalledWith(`${parent}/memory.stat`, "utf8");
  files.set(`${parent}/memory.current`, "1799");
  expect(isMemoryPressureHigh()).toBe(false);
  files.set(`${parent}/memory.current`, "1800");
  expect(isMemoryPressureHigh()).toBe(true);
  files.set(`${parent}/memory.max`, "3000");
  expect(isMemoryPressureHigh()).toBe(false);
  files.set(`${parent}/memory.high`, "2000");
  expect(isMemoryPressureHigh()).toBe(true);
  files.delete(`${parent}/memory.current`);
  expect(isMemoryPressureHigh()).toBe(false);
  files.set(`${parent}/memory.current`, "1800");
  files.set("/proc/self/cgroup", "0::/");
  expect(isMemoryPressureHigh()).toBe(false);
});

it("maps only the service's visible cgroup controllers in a delegated mount", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  delete (process.versions as { bun?: string }).bun;
  vi.spyOn(process, "constrainedMemory").mockReturnValue(0);
  vi.spyOn(os, "freemem").mockReturnValue(8 * GiB);
  vi.spyOn(os, "totalmem").mockReturnValue(16 * GiB);

  const mount = "/sys/fs/cgroup";
  const parent = `${mount}/slice`;
  const decoy = `${mount}/pod/slice`;
  const view = `30 1 0:27 /pod ${mount} rw - cgroup2 cgroup rw`;
  const files = new Map([
    ["/proc/self/cgroup", "0::/pod/slice/service"],
    ["/proc/self/mountinfo", view],
    [`${parent}/memory.max`, "1000"],
    [`${parent}/memory.current`, "799"],
    [`${decoy}/memory.max`, "10"],
    [`${decoy}/memory.current`, "10"],
  ]);
  const read = mockCgroupFiles(files);
  expect(readEffectiveMemoryLimit()).toEqual({
    memoryLimitBytes: 1000,
    memoryLimitSource: "cgroup-v2",
  });
  const readWorkingSet = captureCgroupV2WorkingSetReader();
  expect(readWorkingSet?.()).toBe(799);
  expect(isMemoryPressureHigh()).toBe(false);
  files.set(`${parent}/memory.current`, "800");
  expect(readWorkingSet?.()).toBe(800);
  expect(isMemoryPressureHigh()).toBe(true);
  expect(read.mock.calls.some(([file]) => String(file).startsWith(`${mount}/pod/`))).toBe(false);

  for (const membership of ["/", "/pod-other/slice/service", "/../pod/slice/service"]) {
    files.set("/proc/self/cgroup", `0::${membership}`);
    expect(isMemoryPressureHigh()).toBe(false);
  }
  files.set("/proc/self/cgroup", "0::/pod/slice/service");
  files.set("/proc/self/mountinfo", `1 0 0:27 / ${mount} rw - cgroup2 cgroup rw\n${view}`);
  expect(isMemoryPressureHigh()).toBe(true);
  files.set(
    "/proc/self/mountinfo",
    [
      `1 0 0:27 / ${mount} rw - cgroup2 cgroup rw`,
      `2 1 0:27 /other ${parent} rw - cgroup2 cgroup rw`,
      view,
    ].join("\n"),
  );
  isMemoryPressureHigh = await loadMemoryPressureCheck();
  expect(isMemoryPressureHigh()).toBe(true);
  files.set(
    "/proc/self/mountinfo",
    `${view}\n31 30 0:27 /other ${mount}/sibling rw - cgroup2 cgroup rw`,
  );
  isMemoryPressureHigh = await loadMemoryPressureCheck();
  expect(isMemoryPressureHigh()).toBe(true);
  files.set("/proc/self/mountinfo", `${view}\n31 30 0:27 /other ${parent} rw - cgroup2 cgroup rw`);
  isMemoryPressureHigh = await loadMemoryPressureCheck();
  expect(isMemoryPressureHigh()).toBe(false);
  files.delete("/proc/self/mountinfo");
  isMemoryPressureHigh = await loadMemoryPressureCheck();
  expect(isMemoryPressureHigh()).toBe(false);
});

it("observes parent pressure when its service leaf is overmounted", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  delete (process.versions as { bun?: string }).bun;
  vi.spyOn(process, "constrainedMemory").mockReturnValue(0);
  vi.spyOn(os, "freemem").mockReturnValue(8 * GiB);
  vi.spyOn(os, "totalmem").mockReturnValue(16 * GiB);
  const mount = "/sys/fs/cgroup";
  const parent = `${mount}/pod`;
  const leaf = `${parent}/service`;
  const files = new Map([
    ["/proc/self/cgroup", "0::/pod/service"],
    [`${parent}/memory.max`, "1000"],
    [`${parent}/memory.current`, "800"],
    [`${leaf}/memory.max`, "500"],
  ]);
  const read = mockCgroupFiles(files);
  for (const covered of [`${leaf}/memory.events`, `${leaf}/memory.max`, leaf]) {
    files.set(
      "/proc/self/mountinfo",
      [
        `30 1 0:27 / ${mount} rw - cgroup2 cgroup rw`,
        `31 30 0:27 /elsewhere ${covered} rw - cgroup2 cgroup rw`,
      ].join("\n"),
    );
    read.mockClear();
    isMemoryPressureHigh = await loadMemoryPressureCheck();
    expect(isMemoryPressureHigh()).toBe(true);
    expect(read).not.toHaveBeenCalledWith(covered, "utf8");
  }
});

it("keeps the hard-limit reading when mountinfo is unavailable or the cgroup is bind-mounted onto itself", () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.spyOn(os, "totalmem").mockReturnValue(16 * GiB);
  const mount = "/sys/fs/cgroup";
  const files = new Map([
    ["/proc/self/cgroup", "0::/pod/service"],
    [`${mount}/pod/memory.max`, String(512 * MiB)],
  ]);
  mockCgroupFiles(files);
  const expected = { memoryLimitBytes: 512 * MiB, memoryLimitSource: "cgroup-v2" };
  expect(readEffectiveMemoryLimit()).toEqual(expected);
  files.set("/proc/self/cgroup", "0::/");
  files.set(`${mount}/memory.max`, String(768 * MiB));
  expect(readEffectiveMemoryLimit().memoryLimitBytes).toBe(768 * MiB);
  files.set("/proc/self/cgroup", "0::/pod/service");
  files.set(
    "/proc/self/mountinfo",
    [
      `30 1 0:27 / ${mount} rw - cgroup2 cgroup rw`,
      `31 30 0:27 /pod ${mount}/pod rw - cgroup2 cgroup rw`,
    ].join("\n"),
  );
  expect(readEffectiveMemoryLimit()).toEqual(expected);
});

it("keeps a delegated leaf and its controller files in the same cgroup view", () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const mount = "/sys/fs/cgroup";
  const leaf = `${mount}/service`;
  const base = `30 1 0:27 /pod ${mount} rw - cgroup2 cgroup rw`;
  const files = new Map([
    ["/proc/self/cgroup", "0::/pod/service"],
    ["/proc/self/mountinfo", base],
    [`${mount}/memory.max`, "900"],
    [`${leaf}/memory.max`, "800"],
    [`${leaf}/memory.high`, "700"],
    [`${leaf}/memory.swap.max`, "0"],
    [`${leaf}/memory.current`, "600"],
    [`${leaf}/memory.stat`, "inactive_file 100"],
  ]);
  mockCgroupFiles(files);
  const controllers = ["memory.max", "memory.high", "memory.swap.max"];
  expect(readCgroupV2MemoryLimits(controllers)).toEqual({
    "memory.max": 800,
    "memory.high": 700,
    "memory.swap.max": 0,
  });
  expect(captureCgroupV2WorkingSetReader()?.()).toBe(500);

  const bind = `31 30 0:27 /pod/service ${leaf} rw - cgroup2 cgroup rw`;
  const lowerMask = `29 30 0:28 / ${leaf}/memory.max ro - tmpfs tmpfs rw`;
  files.set("/proc/self/mountinfo", `${base}\n${lowerMask}\n${bind}`);
  expect(readCgroupV2MemoryLimits(["memory.max"])).toEqual({ "memory.max": 800 });
  files.set(
    "/proc/self/mountinfo",
    `${base}\n${bind}\n32 31 0:28 / ${leaf}/memory.current ro - tmpfs tmpfs rw`,
  );
  expect(readCgroupV2MemoryLimits(["memory.max"])).toEqual({ "memory.max": 800 });
  expect(captureCgroupV2WorkingSetReader()?.()).toBeUndefined();
  files.set("/proc/self/mountinfo", `${base}\n31 30 0:27 /other ${leaf} rw - cgroup2 cgroup rw`);
  expect(readCgroupV2MemoryLimits(controllers)).toEqual({ "memory.max": 900 });

  files.set("/proc/self/cgroup", "0::/pod");
  files.set("/proc/self/mountinfo", base);
  expect(readCgroupV2MemoryLimits(["memory.max"])).toEqual({ "memory.max": 900 });
  files.set("/proc/self/cgroup", "0::/pod-other");
  expect(readCgroupV2MemoryLimits(controllers)).toEqual({});
});

it("samples native cron headroom without looking up an ordinary mount again", () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  delete (process.versions as { bun?: string }).bun;
  const native = vi.spyOn(process, "availableMemory").mockReturnValue(GiB);
  const reads = mockCgroupFiles(
    new Map([
      ["/proc/self/cgroup", "0::/service"],
      ["/proc/self/mountinfo", "30 1 0:27 / /sys/fs/cgroup rw - cgroup2 cgroup rw"],
    ]),
  );
  const read = captureServiceAvailableMemoryReader();
  reads.mockClear();
  expect(read()).toBe(GiB);
  native.mockReturnValue(0);
  expect(read()).toBe(0);
  expect(reads).not.toHaveBeenCalled();
});

it("reads fresh delegated charge without rediscovering an unchanged mount", () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  delete (process.versions as { bun?: string }).bun;
  vi.spyOn(os, "freemem").mockReturnValue(8 * GiB);
  vi.spyOn(os, "totalmem").mockReturnValue(16 * GiB);
  const leaf = "/sys/fs/cgroup/service";
  const files = new Map([
    ["/proc/self/cgroup", "0::/pod/service"],
    ["/proc/self/mountinfo", "30 1 0:27 /pod /sys/fs/cgroup rw - cgroup2 cgroup rw"],
    [`${leaf}/memory.max`, "1000"],
    [`${leaf}/memory.high`, "max"],
    [`${leaf}/memory.current`, "799"],
  ]);
  const reads = mockCgroupFiles(files);
  expect(isMemoryPressureHigh()).toBe(false);
  files.set(`${leaf}/memory.current`, "800");
  expect(isMemoryPressureHigh()).toBe(true);
  expect(reads.mock.calls.filter(([file]) => file === "/proc/self/mountinfo")).toHaveLength(1);
});

it("follows the delegated leaf's raw charge across moves without consulting a second controller", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  delete (process.versions as { bun?: string }).bun;
  const nativeLimit = vi.spyOn(process, "constrainedMemory").mockReturnValue(1000);
  const nativeAvailable = vi.spyOn(process, "availableMemory").mockReturnValue(10);
  vi.spyOn(os, "freemem").mockReturnValue(8 * GiB);
  vi.spyOn(os, "totalmem").mockReturnValue(16 * GiB);
  const mount = "/sys/fs/cgroup";
  const mountinfo = `30 1 0:27 /pod ${mount} rw - cgroup2 cgroup rw`;
  const files = new Map([
    ["/proc/self/cgroup", "0::/pod/service"],
    ["/proc/self/mountinfo", mountinfo],
    [
      "/proc/self/limits",
      "Max address space   900 unlimited bytes\nMax data size   850 unlimited bytes",
    ],
    [`${mount}/service/memory.max`, "1000"],
    [`${mount}/service/memory.high`, "max"],
    [`${mount}/service/memory.current`, "10"],
    [`${mount}/other/memory.max`, "1100"],
    [`${mount}/other/memory.high`, "1000"],
    [`${mount}/other/memory.current`, "950"],
    [`${mount}/other/memory.stat`, "inactive_file 945"],
  ]);
  const reads = mockCgroupFiles(files);
  const read = captureDelegatedMemoryPressureReader();
  expect(read?.().availableBytes).toBe(990);
  expect(isMemoryPressureHigh()).toBe(false);
  files.set("/proc/self/cgroup", "0::/pod/other");
  nativeAvailable.mockReturnValue(990);
  expect(read?.().availableBytes).toBe(50);
  expect(isMemoryPressureHigh()).toBe(true);
  files.set(
    "/proc/self/mountinfo",
    `${mountinfo}\n31 30 0:28 / ${mount}/other/memory.current ro - tmpfs tmpfs rw`,
  );
  expect(read?.().availableBytes).toBeUndefined();
  isMemoryPressureHigh = await loadMemoryPressureCheck();
  expect(isMemoryPressureHigh()).toBe(false);
  expect(nativeLimit).not.toHaveBeenCalled();
  expect(nativeAvailable).not.toHaveBeenCalled();
  expect(reads.mock.calls.some(([file]) => String(file).startsWith(`${mount}/pod/`))).toBe(false);
  files.set("/proc/self/cgroup", "0::/");
  expect(read?.().availableBytes).toBeUndefined();
  files.delete("/proc/self/mountinfo");
  expect(read?.().availableBytes).toBeUndefined();
  expect(captureDelegatedMemoryPressureReader()).toBeUndefined();
  files.set("/proc/self/mountinfo", `30 1 0:27 / ${mount} rw - cgroup2 cgroup rw`);
  expect(captureDelegatedMemoryPressureReader()).toBeUndefined();
});

it.each([
  ["1.52.0", 1000, true],
  ["1.52.1", 500, false],
  ["1.53.0", 500, false],
] as const)(
  "preserves libuv %s soft memory limits on the translated leaf",
  (uv, limit, pressured) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    delete (process.versions as { bun?: string }).bun;
    vi.spyOn(os, "freemem").mockReturnValue(8 * GiB);
    vi.spyOn(os, "totalmem").mockReturnValue(16 * GiB);
    const original = Object.getOwnPropertyDescriptor(process.versions, "uv")!;
    Object.defineProperty(process.versions, "uv", { configurable: true, value: uv });
    try {
      const leaf = "/sys/fs/cgroup/service";
      const files = new Map([
        ["/proc/self/cgroup", "0::/pod/service"],
        ["/proc/self/mountinfo", "30 1 0:27 /pod /sys/fs/cgroup rw - cgroup2 cgroup rw"],
        [
          "/proc/self/limits",
          "Max address space   600 unlimited bytes\nMax data size   500 unlimited bytes",
        ],
        [`${leaf}/memory.high`, "1000"],
        [`${leaf}/memory.max`, "2000"],
        [`${leaf}/memory.current`, "820"],
      ]);
      mockCgroupFiles(files);
      expect(captureDelegatedMemoryPressureReader()?.()).toEqual({
        limitBytes: limit,
        availableBytes: 180,
      });
      expect(isMemoryPressureHigh()).toBe(pressured);
    } finally {
      Object.defineProperty(process.versions, "uv", original);
    }
  },
);
