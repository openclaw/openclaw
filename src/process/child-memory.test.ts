import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { resolveHostExecMemoryLimit, watchChildMemory } from "./child-memory.js";

const procfs = vi.hoisted(() => ({
  readFile: vi.fn<(path: string) => Promise<string>>(),
  readdir: vi.fn<(path: string) => Promise<string[]>>(),
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  ...procfs,
}));

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  procfs.readFile.mockReset();
  procfs.readdir.mockReset();
});

it("scales the host bound with host memory, cgroup constraints, and the owner's working set", () => {
  mockProcessPlatform("linux");
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

it("counts descendants from nonleader threads and swapped memory, then stops sampling", async () => {
  vi.useFakeTimers();
  mockProcessPlatform("linux");
  const files: Record<string, string> = {
    "/proc/100/status": "VmRSS:\t32 kB\nVmSwap:\t0 kB\n",
    "/proc/100/task/100/children": "",
    "/proc/100/task/101/children": "200",
    "/proc/200/status": "VmRSS:\t32 kB\nVmSwap:\t80 kB\n",
  };
  const read = procfs.readFile.mockImplementation(async (file) => {
    const value = files[file];
    if (value === undefined) {
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    }
    return value;
  });
  procfs.readdir.mockResolvedValue(["100", "101"]);
  const onLimit = vi.fn();
  const onDiagnostic = vi.fn();
  const stop = watchChildMemory({ pid: 100, limitBytes: 128 * 1024, onLimit, onDiagnostic });
  await vi.advanceTimersByTimeAsync(2000);
  expect(onLimit).toHaveBeenCalledExactlyOnceWith(144 * 1024);
  expect(onDiagnostic).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("1 MiB limit"));
  const reads = read.mock.calls.length;
  await vi.advanceTimersByTimeAsync(5000);
  expect(read).toHaveBeenCalledTimes(reads);
  stop();
});

it.each(["half the bound", "new descendants"])(
  "samples quiet trees every five seconds and returns to one second at %s",
  async (growth) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mockProcessPlatform("linux");
    const files: Record<string, string> = {
      "/proc/100/status": "VmRSS:\t32 kB\n",
      "/proc/100/task/100/children": "",
      "/proc/200/status": "VmRSS:\t16 kB\n",
    };
    const sampledAt: number[] = [];
    procfs.readFile.mockImplementation(async (file) => {
      if (file === "/proc/100/status") {
        sampledAt.push(Date.now());
      }
      const contents = files[file];
      if (contents === undefined) {
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      }
      return contents;
    });
    procfs.readdir.mockImplementation(async (dir) => (dir === "/proc/100/task" ? ["100"] : []));
    const onLimit = vi.fn();
    const onDiagnostic = vi.fn();
    const stop = watchChildMemory({ pid: 100, limitBytes: 128 * 1024, onLimit, onDiagnostic });
    await vi.advanceTimersByTimeAsync(5999);
    expect(sampledAt).toEqual([1000]);
    if (growth === "half the bound") {
      files["/proc/100/status"] = "VmRSS:\t64 kB\n";
    } else {
      files["/proc/100/task/100/children"] = "200";
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
  vi.useFakeTimers();
  mockProcessPlatform("linux");
  const blocked = createDeferred<string>();
  procfs.readFile
    .mockResolvedValueOnce("VmRSS:\t32 kB\n")
    .mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }))
    .mockImplementation(() => blocked.promise);
  procfs.readdir.mockResolvedValue([]);
  const onLimit = vi.fn();
  const onDiagnostic = vi.fn();
  const stop = watchChildMemory({ pid: 100, limitBytes: 128 * 1024, onLimit, onDiagnostic });
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
