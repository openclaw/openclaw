import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { getHostExecMemoryBudget, watchHostExecMemory } from "./child-memory.js";

const procfs = vi.hoisted(() => ({
  readFile: vi.fn<(path: string) => Promise<string>>(),
  readdir: vi.fn<(path: string) => Promise<string[]>>(),
  decodedBytes: 0,
}));
const memoryOwner = vi.hoisted(() => {
  const state: { current?: { budget?: { memoryBytes: number; swapBytes: number } } } = {};
  return state;
});
vi.mock("../shared/global-singleton.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/global-singleton.js")>();
  return {
    ...actual,
    resolveGlobalSingleton: (...args: Parameters<typeof actual.resolveGlobalSingleton>) => {
      if (args[0] !== Symbol.for("openclaw.hostExecMemory")) {
        return actual.resolveGlobalSingleton(...args);
      }
      const create = args[1] as () => { budget?: { memoryBytes: number; swapBytes: number } };
      const owner = create();
      memoryOwner.current = owner;
      return owner;
    },
  };
});
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  readdir: procfs.readdir,
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  readFile: (
    file: string,
    encodingOrCallback: string | ((error: unknown, value?: string | Buffer) => void),
    callback?: (error: unknown, value?: string | Buffer) => void,
  ) => {
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback!;
    void procfs.readFile(file).then(
      (text) => {
        const content = file.endsWith("/status") ? `Name:\tfixture\n${text}` : text;
        if (typeof encodingOrCallback === "string") {
          procfs.decodedBytes += Buffer.byteLength(content);
          done(null, content);
        } else {
          done(null, Buffer.from(content));
        }
      },
      (error: unknown) => done(error),
    );
  },
}));

const stops: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers();
  mockProcessPlatform("linux");
  memoryOwner.current!.budget = { memoryBytes: 128 * 1024, swapBytes: 64 * 1024 };
  procfs.readdir.mockResolvedValue([]);
});
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  memoryOwner.current!.budget = undefined;
  procfs.readFile.mockReset();
  procfs.readdir.mockReset();
  procfs.decodedBytes = 0;
});

function watch(pid = 100) {
  const onLimit = vi.fn();
  const onDiagnostic = vi.fn();
  const stop = watchHostExecMemory({ pid, onLimit, onDiagnostic });
  stops.push(stop);
  return { onLimit, onDiagnostic, stop };
}

function freshBudget() {
  memoryOwner.current!.budget = undefined;
  return getHostExecMemoryBudget();
}

function mockFiles(files: Record<string, string>, onRead = (_file: string) => {}, code = "ENOENT") {
  return procfs.readFile.mockImplementation(async (file) => {
    onRead(file);
    if (files[file] === undefined) {
      throw Object.assign(new Error("gone"), { code });
    }
    return files[file];
  });
}

it("reserves host and Gateway RAM instead of imposing a per-command quarter cap", () => {
  const GiB = 1024 ** 3;
  const meminfo = vi
    .spyOn(fs, "readFileSync")
    .mockReturnValue(`SwapTotal: ${(128 * GiB) / 1024} kB\n`);
  vi.spyOn(os, "totalmem").mockReturnValue(192 * GiB);
  const constrained = vi.spyOn(process, "constrainedMemory").mockReturnValue(0);
  const rss = vi.spyOn(process.memoryUsage, "rss").mockReturnValue(8 * GiB);
  expect(freshBudget()?.memoryBytes).toBe(144 * GiB);
  expect(freshBudget()?.swapBytes).toBe(48 * GiB);
  constrained.mockReturnValue(64 * GiB);
  expect(freshBudget()?.memoryBytes).toBe(44 * GiB);
  expect(freshBudget()?.swapBytes).toBe(16 * GiB);
  constrained.mockReturnValue(4 * GiB);
  rss.mockReturnValue(GiB);
  expect(freshBudget()?.memoryBytes).toBe(2 * GiB);
  // A loaded Gateway must retain the former single-command allowance.
  rss.mockReturnValue((9 * GiB) / 4);
  expect(freshBudget()?.memoryBytes).toBe((7 * GiB) / 8);
  rss.mockReturnValue((9 * GiB) / 4 + 4096);
  expect(freshBudget()?.memoryBytes).toBe(895 * 1024 ** 2);
  rss.mockReturnValue(GiB);
  meminfo.mockImplementation(() => {
    throw new Error("swap facts unavailable");
  });
  expect(freshBudget()?.swapBytes).toBe(0);
  // Once resolved, later Gateway allocations do not change the shared budget.
  memoryOwner.current!.budget = undefined;
  const budget = getHostExecMemoryBudget();
  expect(budget?.memoryBytes).toBe(2 * GiB);
  rss.mockReturnValue(3 * GiB);
  expect(getHostExecMemoryBudget()).toBe(budget);
  mockProcessPlatform("darwin");
  expect(getHostExecMemoryBudget()).toBeUndefined();
});

it.each([
  {
    name: "delegated leaf without memory files",
    group: "/system.slice/openclaw.service/gateway",
    high: false,
  },
  { name: "ancestor throttle", group: "/system.slice/openclaw.service/gateway", high: true },
  { name: "container namespace root", group: "/", high: false },
])("honors inherited RAM and swap constraints at a $name", ({ group, high }) => {
  const GiB = 1024 ** 3;
  const root = "/sys/fs/cgroup";
  const files: Record<string, string> = {
    "/proc/meminfo": `SwapTotal: ${(8 * GiB) / 1024} kB\n`,
    "/proc/self/cgroup": `0::${group}\n`,
    [`${root}/memory.max`]: String(8 * GiB),
    [`${root}/memory.high`]: "max",
    [`${root}/memory.swap.max`]: "0",
    [`${root}/system.slice/memory.max`]: String((high ? 6 : 4) * GiB),
    [`${root}/system.slice/memory.high`]: high ? String(4 * GiB) : "max",
    [`${root}/system.slice/memory.swap.max`]: String(GiB / 2),
    [`${root}/system.slice/openclaw.service/memory.max`]: String(5 * GiB),
    [`${root}/system.slice/openclaw.service/memory.high`]: "max",
    [`${root}/system.slice/openclaw.service/memory.swap.max`]: "max",
  };
  vi.spyOn(fs, "readFileSync").mockImplementation((file) => {
    const value = files[String(file)];
    if (value === undefined) {
      throw Object.assign(new Error("controller unavailable"), { code: "ENOENT" });
    }
    return value;
  });
  vi.spyOn(os, "totalmem").mockReturnValue(32 * GiB);
  vi.spyOn(process, "constrainedMemory").mockReturnValue(0);
  vi.spyOn(process.memoryUsage, "rss").mockReturnValue(128 * 1024 ** 2);
  expect(freshBudget()).toEqual({
    memoryBytes: (group === "/" ? 6 : 3) * GiB,
    swapBytes: 0,
  });
  // An unreadable ancestor must not discard the tighter limits already read.
  delete files[`${root}/memory.max`];
  delete files[`${root}/memory.swap.max`];
  if (group !== "/") {
    expect(freshBudget()).toEqual({ memoryBytes: 3 * GiB, swapBytes: GiB / 2 });
  }
});

it("lets one command borrow unused capacity and cancels one large contributor after aggregate growth", async () => {
  const files = {
    "/proc/100/status": "VmRSS:\t96 kB\n",
    "/proc/200/status": "VmRSS:\t16 kB\n",
  };
  mockFiles(files);
  const context = new AsyncLocalStorage<string>();
  const large = context.run("large", () => watch(100));
  const small = watch(200);
  const contexts: Array<string | undefined> = [];
  large.onLimit.mockImplementation(() => contexts.push(context.getStore()));
  await vi.advanceTimersByTimeAsync(1000);
  expect(large.onLimit).not.toHaveBeenCalled();
  files["/proc/200/status"] = "VmRSS:\t48 kB\n";
  await vi.advanceTimersByTimeAsync(1000);
  expect(large.onLimit).toHaveBeenCalledOnce();
  expect(contexts).toEqual(["large"]);
  expect(large.onDiagnostic).toHaveBeenCalledWith(
    expect.stringContaining("shared host exec memory budget"),
  );
  expect(small.onLimit).not.toHaveBeenCalled();
  // Native cleanup owns release; a pending kill must not cascade to peers.
  await vi.advanceTimersByTimeAsync(5000);
  expect(small.onLimit).not.toHaveBeenCalled();
  large.stop();
  await vi.advanceTimersByTimeAsync(1000);
  expect(small.onLimit).not.toHaveBeenCalled();
});

it.each(["throw", "reject"])(
  "retries a failed cancellation on the next sample: %s",
  async (mode) => {
    mockFiles({ "/proc/100/status": "VmRSS:\t256 kB\n" });
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const { onLimit } = watch();
    onLimit.mockImplementationOnce(() => {
      if (mode === "throw") {
        throw new Error("manager unavailable");
      }
      return Promise.reject(new Error("manager unavailable"));
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onLimit).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onLimit).toHaveBeenCalledTimes(2);
    // An accepted cancellation remains charged until native cleanup unregisters it.
    await vi.advanceTimersByTimeAsync(5000);
    expect(onLimit).toHaveBeenCalledTimes(2);
  },
);

it.each(["ENOENT", "ESRCH"])(
  "counts thread-spawned descendants and enforces swap separately through %s",
  async (code) => {
    mockFiles(
      {
        "/proc/100/status": "VmRSS:\t16 kB\n",
        "/proc/100/task/100/children": "",
        "/proc/100/task/101/children": "200 400 ",
        "/proc/200/status": "VmRSS:\t16 kB\n",
        "/proc/200/task/200/children": "300",
        "/proc/300/status": "VmRSS:\t16 kB\nVmSwap:\t96 kB\n",
      },
      undefined,
      code,
    );
    procfs.readdir.mockImplementation(async (dir) =>
      dir === "/proc/100/task" ? ["100", "101", "102"] : ["200"],
    );
    const { onLimit, onDiagnostic } = watch();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onLimit).toHaveBeenCalledOnce();
    expect(onDiagnostic).toHaveBeenCalledWith(expect.stringContaining("swap 1/1 MiB"));
    expect(procfs.decodedBytes).toBe(0);
  },
);

it("deduplicates overlapping roots and shares procfs reads without scanning unrelated processes", async () => {
  const files = {
    "/proc/100/status": "VmRSS:\t16 kB\n",
    "/proc/100/task/100/children": "200",
    "/proc/200/status": "VmRSS:\t16 kB\n",
    "/proc/200/task/200/children": "300",
    "/proc/300/status": "VmRSS:\t16 kB\n",
    "/proc/400/status": "VmRSS:\t32 kB\n",
  };
  mockFiles(files);
  procfs.readdir.mockImplementation(async (dir) =>
    dir === "/proc" ? ["9999"] : [dir.split("/")[2]!],
  );
  memoryOwner.current!.budget = { memoryBytes: 64 * 1024, swapBytes: 0 };
  const parent = watch(100);
  const child = watch(200);
  await vi.advanceTimersByTimeAsync(1000);
  expect(parent.onLimit).not.toHaveBeenCalled();
  expect(child.onLimit).not.toHaveBeenCalled();
  expect(procfs.readFile.mock.calls.filter(([file]) => file === "/proc/300/status")).toHaveLength(
    1,
  );
  expect(procfs.readdir).not.toHaveBeenCalledWith("/proc");
  const other = watch(400);
  await vi.advanceTimersByTimeAsync(1000);
  expect(parent.onLimit).toHaveBeenCalledOnce();
  expect(child.onLimit).not.toHaveBeenCalled();
  expect(other.onLimit).not.toHaveBeenCalled();
});

it("accounts disjoint durable cgroup usage alongside ordinary trees, including swapped descendants without a MainPID", async () => {
  mockFiles({ "/proc/100/status": "VmRSS:\t80 kB\n" });
  const ordinary = watch();
  const onLimit = vi.fn();
  const usage = { memoryBytes: 32 * 1024, swapBytes: 0 };
  stops.push(watchHostExecMemory({ readUsage: async () => usage, onLimit, onDiagnostic: vi.fn() }));
  await vi.advanceTimersByTimeAsync(1000);
  expect(ordinary.onLimit).not.toHaveBeenCalled();
  usage.swapBytes = 96 * 1024;
  await vi.advanceTimersByTimeAsync(1000);
  expect(onLimit).toHaveBeenCalledOnce();
  expect(ordinary.onLimit).not.toHaveBeenCalled();
});

it.each(["half the budget", "new descendants"])(
  "samples quiet trees every five seconds and returns to one second at %s",
  async (growth) => {
    vi.setSystemTime(0);
    const files = {
      "/proc/100/status": "VmRSS:\t32 kB\n",
      "/proc/100/task/100/children": "",
      "/proc/200/status": "VmRSS:\t16 kB\n",
    };
    const at: number[] = [];
    mockFiles(files, (file) => {
      if (file === "/proc/100/status") {
        at.push(Date.now());
      }
    });
    procfs.readdir.mockImplementation(async (dir) => (dir === "/proc/100/task" ? ["100"] : []));
    const { onLimit } = watch();
    await vi.advanceTimersByTimeAsync(5999);
    expect(at).toEqual([1000]);
    if (growth === "half the budget") {
      files["/proc/100/status"] = "VmRSS:\t64 kB\n";
    } else {
      files["/proc/100/task/100/children"] = "200";
    }
    await vi.advanceTimersByTimeAsync(1);
    expect(at).toEqual([1000, 6000]);
    files["/proc/100/status"] = "VmRSS:\t256 kB\n";
    await vi.advanceTimersByTimeAsync(1000);
    expect(onLimit).toHaveBeenCalledOnce();
  },
);

it("retries failed samples and cancels pending reads without retaining callbacks", async () => {
  const blocked = createDeferred<string>();
  procfs.readFile
    .mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }))
    .mockImplementation(() => blocked.promise);
  const { onLimit, onDiagnostic, stop } = watch();
  await vi.advanceTimersByTimeAsync(2000);
  expect(onDiagnostic).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("protection is degraded"),
  );
  expect(procfs.readFile).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(5000);
  expect(procfs.readFile).toHaveBeenCalledTimes(2);
  stop();
  blocked.resolve("VmRSS:\t256 kB\n");
  await vi.advanceTimersByTimeAsync(1000);
  expect(onLimit).not.toHaveBeenCalled();
});

it("keeps a stalled tree from blocking a peer's aggregate enforcement", async () => {
  const blocked = createDeferred<string>();
  procfs.readFile.mockImplementation(async (file) =>
    file === "/proc/100/status" ? blocked.promise : "VmRSS:\t256 kB\n",
  );
  const stalled = watch(100);
  const peer = watch(200);
  await vi.advanceTimersByTimeAsync(2000);
  expect(peer.onLimit).toHaveBeenCalledOnce();
  expect(stalled.onLimit).not.toHaveBeenCalled();
  stalled.stop();
  blocked.resolve("VmRSS:\t16 kB\n");
  await vi.advanceTimersByTimeAsync(0);
});
