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

beforeEach(() => {
  vi.useFakeTimers();
  mockProcessPlatform("linux");
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  procfs.readFile.mockReset();
  procfs.readdir.mockReset();
  procfs.decodedBytes = 0;
});

function watch() {
  const onLimit = vi.fn();
  const onDiagnostic = vi.fn();
  const stop = watchChildMemory({ pid: 100, limitBytes: 128 * 1024, onLimit, onDiagnostic });
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
