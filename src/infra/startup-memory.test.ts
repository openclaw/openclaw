import { describe, expect, it, vi, beforeEach } from "vitest";
import * as os from "os";
import * as fs from "fs";
import {
  assessGatewayStartupMemory,
  formatBytes,
  formatMemoryAssessmentMessage,
  parseCgroupLimitBytes,
  getEffectiveMemoryBytes,
  GATEWAY_MIN_MEMORY_BYTES,
  GATEWAY_RECOMMENDED_MEMORY_BYTES,
} from "./startup-memory.js";

vi.mock("fs");
vi.mock("os");

describe("startup-memory", () => {
  describe("parseCgroupLimitBytes", () => {
    it("should parse valid byte string", () => {
      expect(parseCgroupLimitBytes("1073741824")).toBe(1024 * 1024 * 1024);
      expect(parseCgroupLimitBytes("2147483648")).toBe(2 * 1024 * 1024 * 1024);
    });

    it("should parse with whitespace", () => {
      expect(parseCgroupLimitBytes("  1073741824  ")).toBe(1024 * 1024 * 1024);
    });

    it("should return null for 'max' (unlimited)", () => {
      expect(parseCgroupLimitBytes("max")).toBeNull();
      expect(parseCgroupLimitBytes("MAX")).toBeNull();
    });

    it("should return null for empty string", () => {
      expect(parseCgroupLimitBytes("")).toBeNull();
      expect(parseCgroupLimitBytes("   ")).toBeNull();
    });

    it("should return null for invalid string", () => {
      expect(parseCgroupLimitBytes("abc")).toBeNull();
      expect(parseCgroupLimitBytes("1.5GB")).toBeNull();
      expect(parseCgroupLimitBytes("-1024")).toBeNull();
    });

    it("should return null for zero", () => {
      expect(parseCgroupLimitBytes("0")).toBeNull();
    });

    it("should return null for very large values (>= 128PB)", () => {
      // 128PB in bytes
      const largeValue = BigInt(128) * BigInt(1024) * BigInt(1024) * BigInt(1024) * BigInt(1024);
      expect(parseCgroupLimitBytes(largeValue.toString())).toBeNull();
    });
  });

  describe("formatBytes", () => {
    it("should format bytes correctly", () => {
      expect(formatBytes(0)).toBe("0.00 B");
      expect(formatBytes(1024)).toBe("1.00 KB");
      expect(formatBytes(1024 * 1024)).toBe("1.00 MB");
      expect(formatBytes(1024 * 1024 * 1024)).toBe("1.00 GB");
    });

    it("should format fractional values", () => {
      expect(formatBytes(1536)).toBe("1.50 KB");
      expect(formatBytes(1024 * 1024 * 1024 * 1.5)).toBe("1.50 GB");
    });
  });

  describe("assessGatewayStartupMemory", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("should return ok status when memory >= 2GB", () => {
      vi.mocked(os.totalmem).mockReturnValue(4 * 1024 * 1024 * 1024); // 4GB
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = assessGatewayStartupMemory();
      expect(result.status).toBe("ok");
      expect(result.effectiveMemoryBytes).toBe(4 * 1024 * 1024 * 1024);
    });

    it("should return warn status when memory >= 1GB but < 2GB", () => {
      vi.mocked(os.totalmem).mockReturnValue(1.5 * 1024 * 1024 * 1024); // 1.5GB
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = assessGatewayStartupMemory();
      expect(result.status).toBe("warn");
      expect(result.effectiveMemoryBytes).toBe(1.5 * 1024 * 1024 * 1024);
    });

    it("should return error status when memory < 1GB", () => {
      vi.mocked(os.totalmem).mockReturnValue(512 * 1024 * 1024); // 512MB
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = assessGatewayStartupMemory();
      expect(result.status).toBe("error");
      expect(result.effectiveMemoryBytes).toBe(512 * 1024 * 1024);
    });

    it("should use cgroup v2 limit when available", () => {
      vi.mocked(os.totalmem).mockReturnValue(8 * 1024 * 1024 * 1024); // 8GB
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        return path === "/sys/fs/cgroup/memory.max";
      });
      vi.mocked(fs.readFileSync).mockImplementation((path) => {
        if (path === "/sys/fs/cgroup/memory.max") {
          return "1073741824"; // 1GB
        }
        return "";
      });

      const result = assessGatewayStartupMemory();
      expect(result.status).toBe("warn");
      expect(result.source).toBe("cgroupv2");
      expect(result.effectiveMemoryBytes).toBe(1024 * 1024 * 1024);
    });

    it("should use cgroup v1 limit when v2 not available", () => {
      vi.mocked(os.totalmem).mockReturnValue(8 * 1024 * 1024 * 1024); // 8GB
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        return path === "/sys/fs/cgroup/memory/memory.limit_in_bytes";
      });
      vi.mocked(fs.readFileSync).mockImplementation((path) => {
        if (path === "/sys/fs/cgroup/memory/memory.limit_in_bytes") {
          return "536870912"; // 512MB
        }
        return "";
      });

      const result = assessGatewayStartupMemory();
      expect(result.status).toBe("error");
      expect(result.source).toBe("cgroupv1");
      expect(result.effectiveMemoryBytes).toBe(512 * 1024 * 1024);
    });

    it("should handle 'max' cgroup limit as unlimited", () => {
      vi.mocked(os.totalmem).mockReturnValue(4 * 1024 * 1024 * 1024); // 4GB
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        return path === "/sys/fs/cgroup/memory.max";
      });
      vi.mocked(fs.readFileSync).mockImplementation((path) => {
        if (path === "/sys/fs/cgroup/memory.max") {
          return "max";
        }
        return "";
      });

      const result = assessGatewayStartupMemory();
      expect(result.status).toBe("ok");
      expect(result.source).toBe("system");
    });

    it("should report system memory when cgroup files don't exist", () => {
      vi.mocked(os.totalmem).mockReturnValue(4 * 1024 * 1024 * 1024); // 4GB
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = assessGatewayStartupMemory();
      expect(result.status).toBe("ok");
      expect(result.source).toBe("system");
      expect(result.totalMemoryBytes).toBe(4 * 1024 * 1024 * 1024);
    });
  });

  describe("formatMemoryAssessmentMessage", () => {
    it("should format error message correctly", () => {
      const result = assessGatewayStartupMemory();
      // Override for testing
      const errorResult = {
        ...result,
        status: "error" as const,
        effectiveMemoryBytes: 512 * 1024 * 1024,
      };
      
      const message = formatMemoryAssessmentMessage(errorResult);
      expect(message).toContain("❌ Insufficient memory");
      expect(message).toContain("512.00 MB");
      expect(message).toContain("1.00 GB (minimum)");
      expect(message).toContain("2.00 GB (recommended)");
    });

    it("should format warn message correctly", () => {
      const warnResult = {
        status: "warn" as const,
        totalMemoryBytes: 1.5 * 1024 * 1024 * 1024,
        effectiveMemoryBytes: 1.5 * 1024 * 1024 * 1024,
        source: "system" as const,
      };
      
      const message = formatMemoryAssessmentMessage(warnResult);
      expect(message).toContain("⚠️ Low memory warning");
      expect(message).toContain("1.50 GB");
    });

    it("should format ok message correctly", () => {
      const okResult = {
        status: "ok" as const,
        totalMemoryBytes: 4 * 1024 * 1024 * 1024,
        effectiveMemoryBytes: 4 * 1024 * 1024 * 1024,
        source: "system" as const,
      };
      
      const message = formatMemoryAssessmentMessage(okResult);
      expect(message).toContain("✅ Sufficient memory");
      expect(message).toContain("4.00 GB");
    });
  });

  describe("getEffectiveMemoryBytes", () => {
    it("should prioritize cgroup v2 over cgroup v1", () => {
      vi.mocked(os.totalmem).mockReturnValue(8 * 1024 * 1024 * 1024);
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        return path === "/sys/fs/cgroup/memory.max";
      });
      vi.mocked(fs.readFileSync).mockImplementation((path) => {
        if (path === "/sys/fs/cgroup/memory.max") {
          return "2147483648"; // 2GB
        }
        return "";
      });

      const result = getEffectiveMemoryBytes();
      expect(result.source).toBe("cgroupv2");
      expect(result.bytes).toBe(2 * 1024 * 1024 * 1024);
    });
  });
});
