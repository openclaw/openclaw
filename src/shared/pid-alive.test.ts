import fsSync from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { isPidAlive } from "./pid-alive.js";

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
