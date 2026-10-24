import { AsyncLocalStorage } from "node:async_hooks";
import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { resolveHostExecMemoryLimit, watchChildMemory } from "./child-memory.js";

const procfs = vi.hoisted(() => ({
  readFile: vi.fn<(path: string) => Promise<Buffer>>(),
  readdir: vi.fn<(path: string) => Promise<string[]>>(),
}));

const stops: (() => void)[] = [];
function watch(pid = 100) {
  const onLimit = vi.fn();
  const onDiagnostic = vi.fn();
  const stop = watchChildMemory({ pid, limitBytes: 128 * 1024, onLimit, onDiagnostic });
  stops.push(stop);
  return { stop, onLimit, onDiagnostic };
}

function mockProc(files: Record<string, string>, beforeRead?: () => Promise<void>) {
  procfs.readFile.mockImplementation(async (path) => {
    await beforeRead?.();
    const contents = files[path];
    if (contents === undefined) {
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    }
    return Buffer.from(contents);
  });
  procfs.readdir.mockResolvedValue([]);
}
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  ...procfs,
}));

afterEach(() => {
  for (const stop of stops.splice(0)) {
    stop();
  }
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

it("counts nonleader descendants and swapped memory without truncating long status files", async () => {
  vi.useFakeTimers();
  mockProcessPlatform("linux");
  const files: Record<string, string> = {
    "/proc/100/status": `Name:\t${"x".repeat(4086)}\nVmRSS:\t32 kB\nVmSwap:\t0 kB\nVmSize:\t999999 kB\n`,
    "/proc/100/task/100/children": "",
    "/proc/100/task/101/children": "200",
    "/proc/200/status": "VmRSS:\t32 kB\nVmSwap:\t80 kB\n",
  };
  mockProc(files);
  procfs.readdir.mockResolvedValue(["100", "101", "102"]);
  const { onLimit, onDiagnostic } = watch();
  await vi.advanceTimersByTimeAsync(2000);
  expect(onLimit).toHaveBeenCalledExactlyOnceWith(144 * 1024);
  expect(onDiagnostic).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("1 MiB limit"));
  const reads = procfs.readFile.mock.calls.length;
  await vi.advanceTimersByTimeAsync(5000);
  expect(procfs.readFile).toHaveBeenCalledTimes(reads);
});

it("cancels an awaited sample without cancelling other trees, then restarts after idle", async () => {
  vi.useFakeTimers();
  mockProcessPlatform("linux");
  const blocked = createDeferred();
  mockProc(
    {
      "/proc/100/status": "VmRSS:\t256 kB\n",
      "/proc/200/status": "VmRSS:\t64 kB\n",
      "/proc/300/status": "VmRSS:\t256 kB\n",
    },
    () => blocked.promise,
  );
  const first = watch();
  const second = watch(200);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(1000);
  first.stop();
  await vi.advanceTimersByTimeAsync(5000);
  expect(procfs.readFile).toHaveBeenCalledTimes(1);
  blocked.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(first.onLimit).not.toHaveBeenCalled();
  expect(first.onDiagnostic).not.toHaveBeenCalled();
  expect(second.onLimit).not.toHaveBeenCalled();
  expect(second.onDiagnostic).not.toHaveBeenCalled();
  expect(procfs.readFile).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(1);
  second.stop();
  expect(vi.getTimerCount()).toBe(0);
  const third = watch(300);
  await vi.advanceTimersByTimeAsync(1000);
  expect(third.onLimit).toHaveBeenCalledExactlyOnceWith(256 * 1024);
  expect(vi.getTimerCount()).toBe(0);
});

it("warns once about an unreadable tree while protecting other trees", async () => {
  vi.useFakeTimers();
  mockProcessPlatform("linux");
  mockProc({ "/proc/200/status": "VmRSS:\t256 kB\n" });
  procfs.readFile.mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
  const unreadable = watch();
  const other = watch(200);
  await vi.advanceTimersByTimeAsync(2000);
  expect(unreadable.onLimit).not.toHaveBeenCalled();
  expect(unreadable.onDiagnostic).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("memory protection is degraded"),
  );
  expect(other.onLimit).toHaveBeenCalledExactlyOnceWith(256 * 1024);
  expect(other.onDiagnostic).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("1 MiB limit"),
  );
});

it("does not sample or warn on non-Linux hosts", async () => {
  vi.useFakeTimers();
  mockProcessPlatform("darwin");
  const { onLimit, onDiagnostic } = watch();
  await vi.advanceTimersByTimeAsync(5000);
  expect(procfs.readFile).not.toHaveBeenCalled();
  expect(onLimit).not.toHaveBeenCalled();
  expect(onDiagnostic).not.toHaveBeenCalled();
});

it("does not retain the first execution's async context in the shared timer", () => {
  vi.useFakeTimers();
  mockProcessPlatform("linux");
  const context = new AsyncLocalStorage<object>();
  const registeredContexts: unknown[] = [];
  const schedule = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
    registeredContexts.push(context.getStore());
    return schedule(callback, delay, ...args);
  });
  context.run({ execution: "first" }, () => watch());
  expect(registeredContexts).toEqual([undefined]);
});
