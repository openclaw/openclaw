import fsSync from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { getProcessStartTime, isPidAlive } from "./pid-alive.js";

function mockProcReads(entries: Record<string, string>) {
  const originalReadFileSync = fsSync.readFileSync;
  vi.spyOn(fsSync, "readFileSync").mockImplementation((filePath, encoding) => {
    const key = String(filePath);
    if (Object.hasOwn(entries, key)) {
      return entries[key] as never;
    }
    return originalReadFileSync(filePath as never, encoding as never) as never;
  });
}

async function withLinuxProcessPlatform<T>(run: () => Promise<T>): Promise<T> {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (!originalPlatformDescriptor) {
    throw new Error("missing process.platform descriptor");
  }
  Object.defineProperty(process, "platform", {
    ...originalPlatformDescriptor,
    value: "linux",
  });
  try {
    vi.resetModules();
    return await run();
  } finally {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
    vi.restoreAllMocks();
  }
}

describe("isPidAlive", () => {
  it("returns true for the current running process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("returns false for a non-existent PID", () => {
    expect(isPidAlive(2 ** 30)).toBe(false);
  });

  it("returns false for invalid PIDs", () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
    expect(isPidAlive(Number.NaN)).toBe(false);
    expect(isPidAlive(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("returns false for zombie processes on Linux", async () => {
    const zombiePid = process.pid;

    mockProcReads({
      [`/proc/${zombiePid}/status`]: `Name:\tnode\nUmask:\t0022\nState:\tZ (zombie)\nTgid:\t${zombiePid}\nPid:\t${zombiePid}\n`,
    });
    await withLinuxProcessPlatform(async () => {
      const { isPidAlive: freshIsPidAlive } = await import("./pid-alive.js");
      expect(freshIsPidAlive(zombiePid)).toBe(false);
    });
  });

  it("handles macOS zombie detection without crashing", async () => {
    if (process.platform !== "darwin") {
      return;
    }
    // On macOS, verify that isPidAlive works and doesn't throw
    // Real zombie processes are hard to create in tests, so we just
    // verify the code path executes without error
    expect(() => isPidAlive(process.pid)).not.toThrow();
    expect(typeof isPidAlive(process.pid)).toBe("boolean");
  });

  it("treats unreadable linux proc status as non-zombie when kill succeeds", async () => {
    const readFileSyncSpy = vi.spyOn(fsSync, "readFileSync").mockImplementation(() => {
      throw new Error("no proc status");
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    await withLinuxProcessPlatform(async () => {
      const { isPidAlive: freshIsPidAlive } = await import("./pid-alive.js");
      expect(freshIsPidAlive(42)).toBe(true);
    });

    expect(readFileSyncSpy).toHaveBeenCalledWith("/proc/42/status", "utf8");
    expect(killSpy).toHaveBeenCalledWith(42, 0);
  });
});

describe("getProcessStartTime", () => {
  it("parses linux /proc stat start times and rejects malformed variants", async () => {
    const fakeStatPrefix = "42 (node) S 1 42 42 0 -1 4194304 12345 0 0 0 100 50 0 0 20 0 8 0 ";
    const fakeStatSuffix =
      " 123456789 5000 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0";
    mockProcReads({
      [`/proc/${process.pid}/stat`]: `${process.pid} (node) S 1 ${process.pid} ${process.pid} 0 -1 4194304 12345 0 0 0 100 50 0 0 20 0 8 0 98765 123456789 5000 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0`,
      "/proc/42/stat": `${fakeStatPrefix}55555${fakeStatSuffix}`,
      "/proc/43/stat": "43 node S malformed",
      "/proc/44/stat": `44 (My App (v2)) S 1 44 44 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 66666 0 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0`,
      "/proc/45/stat": `${fakeStatPrefix}-1${fakeStatSuffix}`,
      "/proc/46/stat": `${fakeStatPrefix}1.5${fakeStatSuffix}`,
    });

    await withLinuxProcessPlatform(async () => {
      const { getProcessStartTime: fresh } = await import("./pid-alive.js");
      expect(fresh(process.pid)).toBe(98765);
      expect(fresh(42)).toBe(55555);
      expect(fresh(43)).toBeNull();
      expect(fresh(44)).toBe(66666);
      expect(fresh(45)).toBeNull();
      expect(fresh(46)).toBeNull();
    });
  });

  it("returns null on non-Linux platforms", () => {
    if (process.platform === "linux") {
      // On actual Linux, this test is trivially satisfied by the other tests.
      expect(true).toBe(true);
      return;
    }
    expect(getProcessStartTime(process.pid)).toBeNull();
  });

  it("returns null for invalid PIDs", () => {
    expect(getProcessStartTime(0)).toBeNull();
    expect(getProcessStartTime(-1)).toBeNull();
    expect(getProcessStartTime(1.5)).toBeNull();
    expect(getProcessStartTime(Number.NaN)).toBeNull();
    expect(getProcessStartTime(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
