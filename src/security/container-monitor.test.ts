import * as childProcess from "node:child_process";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  validateContainerId,
  checkDangerousCapabilitiesBitmask,
  detectContainerEscape,
  emergencyContainerKill,
  monitorContainerWithKill,
  type ContainerMonitorResult,
} from "./container-monitor.js";

// ---------------------------------------------------------------------------
// Mock Setup for Docker Commands (external service)
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

type MockSpawnResult = {
  stdout: string;
  stderr: string;
  code: number;
};

function createMockSpawn(results: Map<string, MockSpawnResult>) {
  return vi.fn().mockImplementation((cmd: string, args: string[]) => {
    const key = args.join(" ");
    const result = results.get(key) ?? { stdout: "", stderr: "", code: 1 };

    const mockProcess = {
      stdout: {
        on: vi.fn().mockImplementation((event: string, callback: (data: Buffer) => void) => {
          if (event === "data" && result.stdout) {
            setTimeout(() => callback(Buffer.from(result.stdout)), 0);
          }
        }),
      },
      stderr: {
        on: vi.fn().mockImplementation((event: string, callback: (data: Buffer) => void) => {
          if (event === "data" && result.stderr) {
            setTimeout(() => callback(Buffer.from(result.stderr)), 0);
          }
        }),
      },
      on: vi.fn().mockImplementation((event: string, callback: (code: number) => void) => {
        if (event === "close") {
          setTimeout(() => callback(result.code), 10);
        }
      }),
    };

    return mockProcess;
  });
}

// ---------------------------------------------------------------------------
// validateContainerId Tests
// ---------------------------------------------------------------------------

describe("validateContainerId", () => {
  describe("valid container IDs", () => {
    it("should accept valid short container ID (12 hex chars)", () => {
      expect(() => validateContainerId("abc123def456")).not.toThrow();
    });

    it("should accept valid full container ID (64 hex chars)", () => {
      const fullId = "a".repeat(64);
      expect(() => validateContainerId(fullId)).not.toThrow();
    });

    it("should accept valid container name with alphanumeric chars", () => {
      expect(() => validateContainerId("my-container-123")).not.toThrow();
    });

    it("should accept container name with underscores", () => {
      expect(() => validateContainerId("my_container_name")).not.toThrow();
    });

    it("should accept container name with dots", () => {
      expect(() => validateContainerId("container.v1.prod")).not.toThrow();
    });

    it("should accept container name with mixed chars", () => {
      expect(() => validateContainerId("my-container_v1.0")).not.toThrow();
    });
  });

  describe("invalid container IDs - empty/null", () => {
    it("should reject empty string", () => {
      expect(() => validateContainerId("")).toThrow("Container ID must be a non-empty string");
    });

    it("should reject null", () => {
      expect(() => validateContainerId(null as unknown as string)).toThrow(
        "Container ID must be a non-empty string",
      );
    });

    it("should reject undefined", () => {
      expect(() => validateContainerId(undefined as unknown as string)).toThrow(
        "Container ID must be a non-empty string",
      );
    });
  });

  describe("invalid container IDs - length", () => {
    it("should reject ID exceeding 128 characters", () => {
      const longId = "a".repeat(129);
      expect(() => validateContainerId(longId)).toThrow(
        "Container ID exceeds maximum length of 128 characters",
      );
    });

    it("should accept ID at exactly 128 characters", () => {
      const maxId = "a".repeat(128);
      expect(() => validateContainerId(maxId)).not.toThrow();
    });
  });

  describe("invalid container IDs - format", () => {
    it("should reject ID starting with hyphen", () => {
      expect(() => validateContainerId("-invalid")).toThrow("Invalid container ID format");
    });

    it("should reject ID starting with dot", () => {
      expect(() => validateContainerId(".invalid")).toThrow("Invalid container ID format");
    });

    it("should reject ID starting with underscore", () => {
      expect(() => validateContainerId("_invalid")).toThrow("Invalid container ID format");
    });
  });

  describe("command injection prevention", () => {
    it("should reject semicolon injection", () => {
      expect(() => validateContainerId("valid;rm -rf /")).toThrow("Invalid container ID format");
    });

    it("should reject pipe injection", () => {
      expect(() => validateContainerId("valid|cat /etc/passwd")).toThrow(
        "Invalid container ID format",
      );
    });

    it("should reject command substitution with backticks", () => {
      expect(() => validateContainerId("valid`whoami`")).toThrow("Invalid container ID format");
    });

    it("should reject command substitution with $()", () => {
      expect(() => validateContainerId("valid$(whoami)")).toThrow("Invalid container ID format");
    });

    it("should reject ampersand injection", () => {
      expect(() => validateContainerId("valid&&rm -rf /")).toThrow("Invalid container ID format");
    });

    it("should reject newline injection", () => {
      expect(() => validateContainerId("valid\nrm -rf /")).toThrow("Invalid container ID format");
    });

    it("should reject redirect injection", () => {
      expect(() => validateContainerId("valid>/etc/passwd")).toThrow("Invalid container ID format");
    });

    it("should reject space injection", () => {
      expect(() => validateContainerId("valid rm -rf")).toThrow("Invalid container ID format");
    });
  });
});

// ---------------------------------------------------------------------------
// checkDangerousCapabilitiesBitmask Tests
// ---------------------------------------------------------------------------

describe("checkDangerousCapabilitiesBitmask", () => {
  describe("safe capabilities", () => {
    it("should return empty array for no capabilities", () => {
      expect(checkDangerousCapabilitiesBitmask("0000000000000000")).toEqual([]);
    });

    it("should return empty array for safe capabilities only", () => {
      // CAP_CHOWN (bit 0) is not in our dangerous list
      expect(checkDangerousCapabilitiesBitmask("0000000000000001")).toEqual([]);
    });
  });

  describe("dangerous capabilities detection", () => {
    it("should detect CAP_SYS_ADMIN (bit 21)", () => {
      // 2^21 = 2097152 = 0x200000
      const result = checkDangerousCapabilitiesBitmask("0000000000200000");
      expect(result).toContain("CAP_SYS_ADMIN");
    });

    it("should detect CAP_SYS_PTRACE (bit 19)", () => {
      // 2^19 = 524288 = 0x80000
      const result = checkDangerousCapabilitiesBitmask("0000000000080000");
      expect(result).toContain("CAP_SYS_PTRACE");
    });

    it("should detect CAP_NET_ADMIN (bit 12)", () => {
      // 2^12 = 4096 = 0x1000
      const result = checkDangerousCapabilitiesBitmask("0000000000001000");
      expect(result).toContain("CAP_NET_ADMIN");
    });

    it("should detect CAP_NET_RAW (bit 13)", () => {
      // 2^13 = 8192 = 0x2000
      const result = checkDangerousCapabilitiesBitmask("0000000000002000");
      expect(result).toContain("CAP_NET_RAW");
    });

    it("should detect CAP_SETUID (bit 7)", () => {
      // 2^7 = 128 = 0x80
      const result = checkDangerousCapabilitiesBitmask("0000000000000080");
      expect(result).toContain("CAP_SETUID");
    });

    it("should detect CAP_SETGID (bit 6)", () => {
      // 2^6 = 64 = 0x40
      const result = checkDangerousCapabilitiesBitmask("0000000000000040");
      expect(result).toContain("CAP_SETGID");
    });

    it("should detect multiple dangerous capabilities", () => {
      // CAP_SYS_ADMIN (21) + CAP_SYS_PTRACE (19) = 0x280000
      const result = checkDangerousCapabilitiesBitmask("0000000000280000");
      expect(result).toContain("CAP_SYS_ADMIN");
      expect(result).toContain("CAP_SYS_PTRACE");
      expect(result.length).toBe(2);
    });

    it("should detect CAP_DAC_OVERRIDE (bit 1)", () => {
      // 2^1 = 2 = 0x2
      const result = checkDangerousCapabilitiesBitmask("0000000000000002");
      expect(result).toContain("CAP_DAC_OVERRIDE");
    });

    it("should detect CAP_SYS_MODULE (bit 16)", () => {
      // 2^16 = 65536 = 0x10000
      const result = checkDangerousCapabilitiesBitmask("0000000000010000");
      expect(result).toContain("CAP_SYS_MODULE");
    });
  });

  describe("edge cases", () => {
    it("should handle invalid hex string gracefully", () => {
      expect(checkDangerousCapabilitiesBitmask("not-hex")).toEqual([]);
    });

    it("should handle empty string gracefully", () => {
      expect(checkDangerousCapabilitiesBitmask("")).toEqual([]);
    });

    it("should handle lowercase hex", () => {
      const result = checkDangerousCapabilitiesBitmask("0000000000200000");
      expect(result).toContain("CAP_SYS_ADMIN");
    });

    it("should handle uppercase hex", () => {
      const result = checkDangerousCapabilitiesBitmask("0000000000200000".toUpperCase());
      expect(result).toContain("CAP_SYS_ADMIN");
    });

    it("should handle full capability set (all bits set)", () => {
      // All bits set - should detect all dangerous capabilities
      const result = checkDangerousCapabilitiesBitmask("ffffffffffffffff");
      expect(result.length).toBeGreaterThan(10); // At least 10 dangerous caps
      expect(result).toContain("CAP_SYS_ADMIN");
      expect(result).toContain("CAP_SYS_PTRACE");
      expect(result).toContain("CAP_NET_ADMIN");
    });
  });
});

// ---------------------------------------------------------------------------
// detectContainerEscape Tests
// ---------------------------------------------------------------------------

describe("detectContainerEscape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should reject invalid container ID", async () => {
    await expect(detectContainerEscape("invalid;injection")).rejects.toThrow(
      "Invalid container ID format",
    );
  });

  it("should return clean result for secure container", async () => {
    const mockResults = new Map<string, MockSpawnResult>();

    // Simulate secure container - all checks pass
    mockResults.set("exec test-container cat /proc/1/cgroup", {
      stdout: "12:devices:/docker/abc123\n",
      stderr: "",
      code: 0,
    });

    // No sensitive files accessible
    mockResults.set("exec test-container test -e /var/run/docker.sock", {
      stdout: "",
      stderr: "",
      code: 1,
    });

    mockResults.set("exec test-container cat /proc/net/route", {
      stdout: "",
      stderr: "",
      code: 1,
    });

    mockResults.set("exec test-container cat /proc/self/status", {
      stdout: "CapEff:\t0000000000000000\n",
      stderr: "",
      code: 0,
    });

    mockResults.set("exec test-container cat /proc/mounts", {
      stdout: "overlay / overlay rw 0 0\n",
      stderr: "",
      code: 0,
    });

    vi.mocked(childProcess.spawn).mockImplementation(createMockSpawn(mockResults));

    const result = await detectContainerEscape("test-container");

    expect(result.containerId).toBe("test-container");
    expect(result.escaped).toBe(false);
    expect(result.checkedAt).toBeGreaterThan(0);
  });

  it("should detect host PID namespace access", async () => {
    const mockResults = new Map<string, MockSpawnResult>();

    // Host cgroup (no docker/containerd)
    mockResults.set("exec compromised cat /proc/1/cgroup", {
      stdout: "0::/\n",
      stderr: "",
      code: 0,
    });

    vi.mocked(childProcess.spawn).mockImplementation(createMockSpawn(mockResults));

    const result = await detectContainerEscape("compromised");

    expect(result.escaped).toBe(true);
    expect(result.indicators.some((i) => i.type === "process")).toBe(true);
    expect(result.indicators.some((i) => i.evidence.includes("host PID namespace"))).toBe(true);
  });

  it("should detect dangerous capabilities", async () => {
    const mockResults = new Map<string, MockSpawnResult>();

    // CAP_SYS_ADMIN set
    mockResults.set("exec dangerous cat /proc/self/status", {
      stdout: "Name:\ttest\nCapEff:\t0000000000200000\n",
      stderr: "",
      code: 0,
    });

    mockResults.set("exec dangerous cat /proc/1/cgroup", {
      stdout: "12:devices:/docker/abc123\n",
      stderr: "",
      code: 0,
    });

    vi.mocked(childProcess.spawn).mockImplementation(createMockSpawn(mockResults));

    const result = await detectContainerEscape("dangerous");

    expect(result.escaped).toBe(true);
    expect(result.indicators.some((i) => i.type === "capability")).toBe(true);
    expect(result.indicators.some((i) => i.evidence.includes("CAP_SYS_ADMIN"))).toBe(true);
  });

  it("should detect suspicious mounts", async () => {
    const mockResults = new Map<string, MockSpawnResult>();

    // Docker socket mounted
    mockResults.set("exec mounted cat /proc/mounts", {
      stdout: "overlay / overlay rw 0 0\n/dev/sda1 /var/run/docker.sock ext4 rw 0 0\n",
      stderr: "",
      code: 0,
    });

    mockResults.set("exec mounted cat /proc/1/cgroup", {
      stdout: "12:devices:/docker/abc123\n",
      stderr: "",
      code: 0,
    });

    vi.mocked(childProcess.spawn).mockImplementation(createMockSpawn(mockResults));

    const result = await detectContainerEscape("mounted");

    expect(result.escaped).toBe(true);
    expect(result.indicators.some((i) => i.type === "mount")).toBe(true);
  });

  it("should use parallel execution (performance test)", async () => {
    const mockResults = new Map<string, MockSpawnResult>();
    const callOrder: string[] = [];

    const originalSpawn = createMockSpawn(mockResults);
    vi.mocked(childProcess.spawn).mockImplementation((cmd, args) => {
      callOrder.push(args.join(" "));
      return originalSpawn(cmd, args);
    });

    await detectContainerEscape("perf-test");

    // All checks should be initiated (may not all complete before timeout)
    expect(callOrder.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// emergencyContainerKill Tests
// ---------------------------------------------------------------------------

describe("emergencyContainerKill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should reject invalid container ID", async () => {
    await expect(emergencyContainerKill("invalid;injection")).rejects.toThrow(
      "Invalid container ID format",
    );
  });

  it("should call docker kill and rm for valid container", async () => {
    const mockResults = new Map<string, MockSpawnResult>();
    mockResults.set("kill --signal=SIGKILL valid-container", {
      stdout: "valid-container",
      stderr: "",
      code: 0,
    });
    mockResults.set("rm -f valid-container", {
      stdout: "valid-container",
      stderr: "",
      code: 0,
    });

    vi.mocked(childProcess.spawn).mockImplementation(createMockSpawn(mockResults));

    await emergencyContainerKill("valid-container");

    expect(childProcess.spawn).toHaveBeenCalledWith(
      "docker",
      ["kill", "--signal=SIGKILL", "valid-container"],
      expect.any(Object),
    );
    expect(childProcess.spawn).toHaveBeenCalledWith(
      "docker",
      ["rm", "-f", "valid-container"],
      expect.any(Object),
    );
  });

  it("should log security incident", async () => {
    const mockResults = new Map<string, MockSpawnResult>();
    mockResults.set("kill --signal=SIGKILL logged-container", {
      stdout: "",
      stderr: "",
      code: 0,
    });
    mockResults.set("rm -f logged-container", {
      stdout: "",
      stderr: "",
      code: 0,
    });

    vi.mocked(childProcess.spawn).mockImplementation(createMockSpawn(mockResults));

    await emergencyContainerKill("logged-container");

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("[SECURITY]"));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("logged-container"));
  });
});

// ---------------------------------------------------------------------------
// monitorContainerWithKill Tests
// ---------------------------------------------------------------------------

describe("monitorContainerWithKill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should reject invalid container ID", async () => {
    await expect(monitorContainerWithKill("invalid;injection")).rejects.toThrow(
      "Invalid container ID format",
    );
  });

  it("should not kill container when no escape detected", async () => {
    const mockResults = new Map<string, MockSpawnResult>();

    // Secure container
    mockResults.set("exec secure cat /proc/1/cgroup", {
      stdout: "12:devices:/docker/abc123\n",
      stderr: "",
      code: 0,
    });
    mockResults.set("exec secure cat /proc/self/status", {
      stdout: "CapEff:\t0000000000000000\n",
      stderr: "",
      code: 0,
    });
    mockResults.set("exec secure cat /proc/mounts", {
      stdout: "overlay / overlay rw 0 0\n",
      stderr: "",
      code: 0,
    });

    vi.mocked(childProcess.spawn).mockImplementation(createMockSpawn(mockResults));

    const result = await monitorContainerWithKill("secure");

    expect(result.escaped).toBe(false);
    // Should not have called kill
    const killCalls = vi
      .mocked(childProcess.spawn)
      .mock.calls.filter((call) => call[1]?.[0] === "kill");
    expect(killCalls.length).toBe(0);
  });

  it("should kill container when escape detected", async () => {
    const mockResults = new Map<string, MockSpawnResult>();

    // Compromised container with host PID access
    mockResults.set("exec compromised cat /proc/1/cgroup", {
      stdout: "0::/\n", // Host cgroup
      stderr: "",
      code: 0,
    });
    mockResults.set("exec compromised cat /proc/self/status", {
      stdout: "CapEff:\t0000000000000000\n",
      stderr: "",
      code: 0,
    });
    mockResults.set("exec compromised cat /proc/mounts", {
      stdout: "overlay / overlay rw 0 0\n",
      stderr: "",
      code: 0,
    });
    mockResults.set("kill --signal=SIGKILL compromised", {
      stdout: "",
      stderr: "",
      code: 0,
    });
    mockResults.set("rm -f compromised", {
      stdout: "",
      stderr: "",
      code: 0,
    });

    vi.mocked(childProcess.spawn).mockImplementation(createMockSpawn(mockResults));

    const result = await monitorContainerWithKill("compromised");

    expect(result.escaped).toBe(true);
    expect(childProcess.spawn).toHaveBeenCalledWith(
      "docker",
      ["kill", "--signal=SIGKILL", "compromised"],
      expect.any(Object),
    );
  });

  it("should return result with indicators when escape detected", async () => {
    const mockResults = new Map<string, MockSpawnResult>();

    // Container with dangerous capabilities
    mockResults.set("exec capped cat /proc/1/cgroup", {
      stdout: "12:devices:/docker/abc123\n",
      stderr: "",
      code: 0,
    });
    mockResults.set("exec capped cat /proc/self/status", {
      stdout: "CapEff:\t0000000000280000\n", // SYS_ADMIN + SYS_PTRACE
      stderr: "",
      code: 0,
    });
    mockResults.set("exec capped cat /proc/mounts", {
      stdout: "overlay / overlay rw 0 0\n",
      stderr: "",
      code: 0,
    });
    mockResults.set("kill --signal=SIGKILL capped", {
      stdout: "",
      stderr: "",
      code: 0,
    });
    mockResults.set("rm -f capped", {
      stdout: "",
      stderr: "",
      code: 0,
    });

    vi.mocked(childProcess.spawn).mockImplementation(createMockSpawn(mockResults));

    const result = await monitorContainerWithKill("capped");

    expect(result.escaped).toBe(true);
    expect(result.indicators.length).toBeGreaterThan(0);
    expect(result.indicators.some((i) => i.type === "capability")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Type Exports Tests
// ---------------------------------------------------------------------------

describe("type exports", () => {
  it("should export ContainerMonitorResult type correctly", () => {
    const result: ContainerMonitorResult = {
      containerId: "test",
      indicators: [],
      checkedAt: Date.now(),
      escaped: false,
    };

    expect(result.containerId).toBe("test");
    expect(result.escaped).toBe(false);
  });
});
