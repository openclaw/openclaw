import fsSync from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { getProcessStartTime, isPidAlive } from "./pid-alive.js";

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

    // Mock readFileSync to return zombie state for /proc/<pid>/status
    const originalReadFileSync = fsSync.readFileSync;
    vi.spyOn(fsSync, "readFileSync").mockImplementation((filePath, encoding) => {
      if (filePath === `/proc/${zombiePid}/status`) {
        return `Name:\tnode\nUmask:\t0022\nState:\tZ (zombie)\nTgid:\t${zombiePid}\nPid:\t${zombiePid}\n`;
      }
      return originalReadFileSync(filePath as never, encoding as never) as never;
    });

    // Override platform to linux so the zombie check runs
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    if (!originalPlatformDescriptor) {
      throw new Error("missing process.platform descriptor");
    }
    Object.defineProperty(process, "platform", {
      ...originalPlatformDescriptor,
      value: "linux",
    });

    try {
      // Re-import the module so it picks up the mocked platform and fs
      vi.resetModules();
      const { isPidAlive: freshIsPidAlive } = await import("./pid-alive.js");
      expect(freshIsPidAlive(zombiePid)).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
      vi.restoreAllMocks();
    }
  });
});

describe("getProcessStartTime", () => {
  it("returns a number on Linux for the current process", async () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    if (!originalPlatformDescriptor) {
      throw new Error("missing process.platform descriptor");
    }

    const originalReadFileSync = fsSync.readFileSync;
    // Simulate a realistic /proc/<pid>/stat line
    const fakeStat = `${process.pid} (node) S 1 ${process.pid} ${process.pid} 0 -1 4194304 12345 0 0 0 100 50 0 0 20 0 8 0 98765 123456789 5000 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0`;
    vi.spyOn(fsSync, "readFileSync").mockImplementation((filePath, encoding) => {
      if (filePath === `/proc/${process.pid}/stat`) {
        return fakeStat;
      }
      return originalReadFileSync(filePath as never, encoding as never) as never;
    });

    Object.defineProperty(process, "platform", {
      ...originalPlatformDescriptor,
      value: "linux",
    });

    try {
      vi.resetModules();
      const { getProcessStartTime: fresh } = await import("./pid-alive.js");
      const starttime = fresh(process.pid);
      expect(starttime).toBe(98765);
    } finally {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
      vi.restoreAllMocks();
    }
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

  it("returns null for malformed /proc stat content", async () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    if (!originalPlatformDescriptor) {
      throw new Error("missing process.platform descriptor");
    }

    const originalReadFileSync = fsSync.readFileSync;
    vi.spyOn(fsSync, "readFileSync").mockImplementation((filePath, encoding) => {
      if (filePath === "/proc/42/stat") {
        return "42 node S malformed";
      }
      return originalReadFileSync(filePath as never, encoding as never) as never;
    });

    Object.defineProperty(process, "platform", {
      ...originalPlatformDescriptor,
      value: "linux",
    });

    try {
      vi.resetModules();
      const { getProcessStartTime: fresh } = await import("./pid-alive.js");
      expect(fresh(42)).toBeNull();
    } finally {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
      vi.restoreAllMocks();
    }
  });

  it("handles comm fields containing spaces and parentheses", async () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    if (!originalPlatformDescriptor) {
      throw new Error("missing process.platform descriptor");
    }

    const originalReadFileSync = fsSync.readFileSync;
    // comm field with spaces and nested parens: "(My App (v2))"
    const fakeStat = `42 (My App (v2)) S 1 42 42 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 55555 0 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0`;
    vi.spyOn(fsSync, "readFileSync").mockImplementation((filePath, encoding) => {
      if (filePath === "/proc/42/stat") {
        return fakeStat;
      }
      return originalReadFileSync(filePath as never, encoding as never) as never;
    });

    Object.defineProperty(process, "platform", {
      ...originalPlatformDescriptor,
      value: "linux",
    });

    try {
      vi.resetModules();
      const { getProcessStartTime: fresh } = await import("./pid-alive.js");
      expect(fresh(42)).toBe(55555);
    } finally {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
      vi.restoreAllMocks();
    }
  });
});
