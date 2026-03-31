import { describe, it, expect, vi, beforeEach } from "vitest";
import { isAppleSilicon, getPhysicalCpuCount, getMemoryInfo } from "./platform.js";

describe("Platform Utilities", () => {
  describe("isAppleSilicon", () => {
    beforeEach(() => {
      vi.resetAllMocks();
    });

    it("should return true on Apple Silicon (darwin arm64)", () => {
      vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      
      expect(isAppleSilicon()).toBe(true);
    });

    it("should return false on non-Apple Silicon macOS", () => {
      vi.spyOn(process, "arch", "get").mockReturnValue("x64");
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      
      expect(isAppleSilicon()).toBe(false);
    });

    it("should return false on Apple Silicon but non-macOS", () => {
      vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      
      expect(isAppleSilicon()).toBe(false);
    });

    it("should return false on Windows", () => {
      vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      
      expect(isAppleSilicon()).toBe(false);
    });
  });

  describe("getPhysicalCpuCount", () => {
    beforeEach(() => {
      vi.resetAllMocks();
    });

    it("should return physical core count on Apple Silicon", () => {
      vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      
      // Mock execSync
      const mockExecSync = vi.fn().mockReturnValue("8\n");
      vi.doMock("node:child_process", () => ({
        execSync: mockExecSync,
      }));

      const { getPhysicalCpuCount } = await import("./platform.js");
      expect(getPhysicalCpuCount()).toBe(8);
    });

    it("should fallback to logical CPU count on non-Apple Silicon", () => {
      vi.spyOn(process, "arch", "get").mockReturnValue("x64");
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      
      const os = await import("node:os");
      const mockCpus = [{}, {}, {}, {}];
      vi.spyOn(os, "cpus", "get").mockReturnValue(mockCpus as any);

      const { getPhysicalCpuCount } = await import("./platform.js");
      expect(getPhysicalCpuCount()).toBe(4);
    });
  });

  describe("getMemoryInfo", () => {
    it("should return memory info with Apple Silicon flag", () => {
      vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

      const { getMemoryInfo } = await import("./platform.js");
      const info = getMemoryInfo();

      expect(info.isAppleSilicon).toBe(true);
      expect(info.total).toBeDefined();
      expect(info.free).toBeDefined();
      expect(info.usagePercentage).toBeGreaterThanOrEqual(0);
    });

    it("should return memory info for non-Apple Silicon", () => {
      vi.spyOn(process, "arch", "get").mockReturnValue("x64");
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");

      const { getMemoryInfo } = await import("./platform.js");
      const info = getMemoryInfo();

      expect(info.isAppleSilicon).toBe(false);
    });
  });

  describe("getOptimalBufferSize", () => {
    it("should return larger buffer size on ARM64", () => {
      vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
      
      const { getOptimalBufferSize } = await import("./platform.js");
      expect(getOptimalBufferSize()).toBe(128 * 1024);
    });

    it("should return standard buffer size on non-ARM64", () => {
      vi.spyOn(process, "arch", "get").mockReturnValue("x64");
      
      const { getOptimalBufferSize } = await import("./platform.js");
      expect(getOptimalBufferSize()).toBe(64 * 1024);
    });
  });

  describe("getOptimalParallelFactor", () => {
    it("should return all cores on Apple Silicon", () => {
      vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

      const os = await import("node:os");
      const mockCpus = Array(8).fill({});
      vi.spyOn(os, "cpus", "get").mockReturnValue(mockCpus as any);

      const { getOptimalParallelFactor } = await import("./platform.js");
      expect(getOptimalParallelFactor()).toBe(8);
    });
  });

  describe("getSpawnOptions", () => {
    it("should set detached on Apple Silicon", () => {
      vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

      const { getSpawnOptions } = await import("./platform.js");
      const options = getSpawnOptions();

      expect(options.detached).toBe(true);
    });
  });

  describe("getShellCommand", () => {
    it("should prefer zsh on Apple Silicon macOS", () => {
      vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

      const { getShellCommand } = await import("./platform.js");
      const shell = getShellCommand();

      expect(shell.shell).toBe("/bin/zsh");
    });
  });

  describe("getTimeoutMultiplier", () => {
    it("should return 1.0 on Apple Silicon", () => {
      vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

      const { getTimeoutMultiplier } = await import("./platform.js");
      expect(getTimeoutMultiplier()).toBe(1.0);
    });

    it("should return 1.2 on non-Apple Silicon", () => {
      vi.spyOn(process, "arch", "get").mockReturnValue("x64");
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");

      const { getTimeoutMultiplier } = await import("./platform.js");
      expect(getTimeoutMultiplier()).toBe(1.2);
    });
  });
});
