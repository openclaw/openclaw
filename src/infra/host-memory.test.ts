import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildPreparedCliRunContext } from "../agents/cli-runner.test-helpers.js";
import { ensureCliLiveSessionMemory } from "../agents/cli-runner/cli-live-session-registry.js";
import {
  isMemoryPressureHigh,
  readHostFreeMemoryBytes,
  readProcessAvailableMemoryBytes,
} from "./host-memory.js";
import { resolveUpdateHashWorkerCount } from "./worker-pool-sizing.js";

const PAGE_BYTES = 16 * 1024;
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
// vm_statistics_data_t counters reported by the simulated macOS kernel.
const mach = vi.hoisted(() => ({ free: 0, inactive: 0, purgeable: 0 }));

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

beforeEach(() => {
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
  vi.spyOn(process, "platform", "get").mockReturnValue(sample.platform ?? "linux");
  Object.defineProperty(process.versions, "bun", { configurable: true, value: sample.bun });
  vi.spyOn(process, "constrainedMemory").mockReturnValue(sample.limit);
  vi.spyOn(process, "availableMemory").mockReturnValue(sample.available ?? GiB);
  // Node/Linux os.freemem() exposes MemAvailable, including reclaimable pages, not MemFree.
  vi.spyOn(os, "freemem").mockReturnValue(sample.free ?? 200 * MiB);
  vi.spyOn(os, "totalmem").mockReturnValue(sample.total ?? 353 * MiB);

  expect(isMemoryPressureHigh()).toBe(sample.expected);
});
