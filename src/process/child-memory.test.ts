import { AsyncLocalStorage } from "node:async_hooks";
import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { resolveHostExecMemoryLimit, watchChildMemory } from "./child-memory.js";

const procfs = vi.hoisted(() => ({
  readFile: vi.fn<(path: string) => Promise<string>>(),
  readdir: vi.fn<(path: string) => Promise<string[]>>(),
  decodedBytes: 0,
}));
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
});
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  procfs.readFile.mockReset();
  procfs.readdir.mockReset();
  procfs.decodedBytes = 0;
});

function watch(pid = 100, limitBytes = 128 * 1024) {
  const onLimit = vi.fn();
  const onDiagnostic = vi.fn();
  const stop = watchChildMemory({ pid, limitBytes, onLimit, onDiagnostic });
  stops.push(stop);
  return { onLimit, onDiagnostic, stop };
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

it("scales the host bound with host memory, cgroup constraints, and the owner's working set", () => {
  const GiB = 1024 ** 3;
  vi.spyOn(os, "totalmem").mockReturnValue(192 * GiB);
  const constrained = vi.spyOn(process, "constrainedMemory").mockReturnValue(0);
  const rss = vi.spyOn(process.memoryUsage, "rss").mockReturnValue(8 * GiB);
  expect(resolveHostExecMemoryLimit()).toBe(48 * GiB);
  constrained.mockReturnValue(64 * GiB);
  expect(resolveHostExecMemoryLimit()).toBe(16 * GiB);
  constrained.mockReturnValue(4 * GiB);
  rss.mockReturnValue(GiB);
  expect(resolveHostExecMemoryLimit()).toBe(GiB);
  rss.mockReturnValue(3 * GiB);
  expect(resolveHostExecMemoryLimit()).toBe(GiB / 2);
  mockProcessPlatform("darwin");
  expect(resolveHostExecMemoryLimit()).toBeUndefined();
});

it.each(["ENOENT", "ESRCH"])(
  "counts thread-spawned grandchildren and swap through %s races",
  async (code) => {
    const read = mockFiles(
      {
        "/proc/100/status": `Groups:\t${"1 ".repeat(3000)}\nVmRSS:\t16 kB\n`,
        "/proc/100/task/100/children": "",
        "/proc/100/task/101/children": "200 400 ",
        "/proc/200/status": "VmRSS:\t16 kB\n",
        "/proc/200/task/200/children": "300",
        "/proc/300/status": "VmRSS:\t16 kB\nVmSwap:\t96 kB\n",
      },
      undefined,
      code,
    );
    procfs.readdir.mockImplementation(async (path) =>
      path === "/proc/100/task" ? ["100", "101", "102"] : ["200"],
    );
    const { onLimit, onDiagnostic, stop } = watch();
    await vi.advanceTimersByTimeAsync(2000);
    expect(onLimit).toHaveBeenCalledExactlyOnceWith(144 * 1024);
    expect(onDiagnostic).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("1 MiB limit"));
    expect(procfs.decodedBytes).toBe(0);
    const reads = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(reads);
    stop();
  },
);

it.each(["half the bound", "new descendants"])(
  "samples quiet trees every five seconds and returns to one second at %s",
  async (growth) => {
    vi.setSystemTime(0);
    const files: Record<string, string> = {
      "/proc/100/status": "VmRSS:\t32 kB\n",
      "/proc/100/task/100/children": "",
      "/proc/100/task/101/children": "",
      "/proc/200/status": "VmRSS:\t16 kB\n",
    };
    const sampledAt: number[] = [];
    mockFiles(files, (file) => {
      if (file === "/proc/100/status") {
        sampledAt.push(Date.now());
      }
    });
    procfs.readdir.mockImplementation(async (dir) =>
      dir === "/proc/100/task" ? ["100", "101"] : [],
    );
    const { onLimit, onDiagnostic, stop } = watch();
    await vi.advanceTimersByTimeAsync(5999);
    expect(sampledAt).toEqual([1000]);
    if (growth === "half the bound") {
      files["/proc/100/status"] = "VmRSS:\t64 kB\n";
    } else {
      files["/proc/100/task/101/children"] = "200";
    }
    await vi.advanceTimersByTimeAsync(1);
    expect(sampledAt).toEqual([1000, 6000]);
    expect(onLimit).not.toHaveBeenCalled();
    files["/proc/100/status"] = "VmRSS:\t256 kB\n";
    await vi.advanceTimersByTimeAsync(1000);
    expect(sampledAt).toEqual([1000, 6000, 7000]);
    expect(onLimit).toHaveBeenCalledExactlyOnceWith(256 * 1024);
    expect(onDiagnostic).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("1 MiB limit"));
    stop();
  },
);

it("retries a failed quiet-tree sample after one second and cancels an awaited retry", async () => {
  const blocked = createDeferred<string>();
  procfs.readFile
    .mockResolvedValueOnce("VmRSS:\t32 kB\n")
    .mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }))
    .mockImplementation(() => blocked.promise);
  procfs.readdir.mockResolvedValue([]);
  const { onLimit, onDiagnostic, stop } = watch();
  await vi.advanceTimersByTimeAsync(6000);
  expect(procfs.readFile).toHaveBeenCalledTimes(2);
  expect(onDiagnostic).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("memory protection is degraded"),
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(procfs.readFile).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(5000);
  expect(procfs.readFile).toHaveBeenCalledTimes(3);
  stop();
  blocked.resolve("VmRSS:\t256 kB\n");
  await vi.advanceTimersByTimeAsync(5000);
  expect(onLimit).not.toHaveBeenCalled();
  expect(onDiagnostic).toHaveBeenCalledTimes(1);
  expect(procfs.readFile).toHaveBeenCalledTimes(3);
});

it("enters a census at twenty watches, keeps it at twelve, and resets after the last stop", async () => {
  const pids = Array.from({ length: 20 }, (_, index) => (index + 1) * 100);
  mockFiles(
    Object.fromEntries(pids.map((pid) => [`/proc/${pid}/status`, "PPid:\t1\nVmRSS:\t64 kB\n"])),
  );
  procfs.readdir.mockImplementation(async (dir) => (dir === "/proc" ? pids.map(String) : []));
  const active = pids.slice(0, 19).map((pid) => watch(pid));
  const tick = async (censuses: number) => {
    procfs.readdir.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(procfs.readdir.mock.calls.filter(([dir]) => dir === "/proc")).toHaveLength(censuses);
  };
  await tick(0);
  active.push(watch(2000));
  await tick(1);
  while (active.length > 12) {
    active.pop()!.stop();
    await tick(1);
  }
  active.pop()!.stop();
  await tick(0);
  active.push(...pids.slice(11).map((pid) => watch(pid)));
  await tick(1);
  active.forEach(({ stop }) => stop());
  pids.slice(0, 12).forEach((pid) => watch(pid));
  await tick(0);
});

it("charges a shared descendant's RSS and swap to both watched ancestors with one read", async () => {
  const peers = Array.from({ length: 18 }, (_, index) => (index + 4) * 100);
  const files = {
    "/proc/100/status": "PPid:\t1\nVmRSS:\t16 kB\n",
    "/proc/200/status": "PPid:\t100\nVmRSS:\t16 kB\n",
    "/proc/300/status": "PPid:\t200\nVmRSS:\t16 kB\nVmSwap:\t96 kB\n",
    ...Object.fromEntries(peers.map((pid) => [`/proc/${pid}/status`, "PPid:\t1\nVmRSS:\t64 kB\n"])),
    "/proc/100/task/100/children": "",
    "/proc/100/task/101/children": "200",
    "/proc/200/task/200/children": "300",
    "/proc/300/task/300/children": "",
    "/proc/400/task/400/children": "",
    "/proc/500/task/500/children": "",
  };
  mockFiles(files);
  procfs.readdir.mockImplementation(async (dir) =>
    dir === "/proc"
      ? ["self", "100", "200", "300", ...peers.map(String), "9999"]
      : dir === "/proc/100/task"
        ? ["100", "101"]
        : [dir.slice("/proc/".length, -"/task".length)],
  );
  const context = new AsyncLocalStorage<string>();
  const callbacks: Array<string | undefined> = [];
  const parent = context.run("parent", () => watch());
  const child = context.run("child", () => watch(200, 120 * 1024));
  parent.onLimit.mockImplementation(() => callbacks.push(context.getStore()));
  child.onLimit.mockImplementation(() => callbacks.push(context.getStore()));
  peers.forEach((pid) => watch(pid));
  await vi.advanceTimersByTimeAsync(1000);
  expect(callbacks).toEqual(["parent", "child"]);
  expect(parent.onLimit).toHaveBeenCalledExactlyOnceWith(144 * 1024);
  expect(child.onLimit).toHaveBeenCalledExactlyOnceWith(128 * 1024);
  expect(procfs.readFile.mock.calls.filter(([file]) => file === "/proc/300/status")).toHaveLength(
    1,
  );
  expect(parent.onDiagnostic).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("Command killed"),
  );
  expect(child.onDiagnostic).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("Command killed"),
  );
});

it.each([2, 20])(
  "keeps peer limits independent of a pending read with %i watches",
  async (count) => {
    const blocked = createDeferred<string>();
    let peerRss = 64;
    procfs.readFile.mockImplementation(async (file) =>
      file === "/proc/100/status"
        ? blocked.promise
        : `PPid:\t1\nVmRSS:\t${file === "/proc/200/status" ? peerRss : 64} kB\n`,
    );
    const pids = Array.from({ length: count }, (_, index) => (index + 1) * 100);
    procfs.readdir.mockImplementation(async (dir) => (dir === "/proc" ? pids.map(String) : []));
    const cancelled = watch();
    const peer = watch(200);
    pids.slice(2).forEach((pid) => watch(pid));
    try {
      await vi.advanceTimersByTimeAsync(1500);
      peerRss = 256;
      await vi.advanceTimersByTimeAsync(1000);
      expect(peer.onLimit).toHaveBeenCalledExactlyOnceWith(256 * 1024);
      expect(peer.onDiagnostic).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("Command killed"),
      );
      expect(procfs.readdir.mock.calls.filter(([dir]) => dir === "/proc")).toHaveLength(
        count === 20 ? 1 : 0,
      );
    } finally {
      cancelled.stop();
      blocked.resolve("PPid:\t1\nVmRSS:\t256 kB\n");
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(cancelled.onLimit).not.toHaveBeenCalled();
    expect(cancelled.onDiagnostic).not.toHaveBeenCalled();
  },
);

it("falls back to owned trees when an unrelated process cannot be read", async () => {
  const pids = Array.from({ length: 20 }, (_, index) => (index + 1) * 100);
  mockFiles(
    Object.fromEntries(pids.map((pid) => [`/proc/${pid}/status`, "PPid:\t1\nVmRSS:\t256 kB\n"])),
    undefined,
    "EACCES",
  );
  procfs.readdir.mockResolvedValue([...pids.map(String), "999"]);
  const active = pids.map((pid) => watch(pid));
  await vi.advanceTimersByTimeAsync(1000);
  for (const { onLimit, onDiagnostic } of active) {
    expect(onLimit).toHaveBeenCalledExactlyOnceWith(256 * 1024);
    expect(onDiagnostic).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Command killed"));
  }
});
