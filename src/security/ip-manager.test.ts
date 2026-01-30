import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import { IpManager } from "./ip-manager.js";

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue("{}"),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    promises: {
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue("{}"),
      unlink: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

describe("IpManager", () => {
  let manager: IpManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new IpManager();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("blockIp", () => {
    it("should block an IP address", () => {
      manager.blockIp({
        ip: "192.168.1.100",
        reason: "brute_force",
        durationMs: 86400000,
      });

      const blockReason = manager.isBlocked("192.168.1.100");
      expect(blockReason).toBe("brute_force");
    });

    it("should block with auto source by default", () => {
      manager.blockIp({
        ip: "192.168.1.100",
        reason: "test",
        durationMs: 86400000,
      });

      expect(manager.isBlocked("192.168.1.100")).toBe("test");
    });

    it("should block with manual source", () => {
      manager.blockIp({
        ip: "192.168.1.100",
        reason: "manual_block",
        durationMs: 86400000,
        source: "manual",
      });

      expect(manager.isBlocked("192.168.1.100")).toBe("manual_block");
    });

    it("should handle IPv6 addresses", () => {
      manager.blockIp({
        ip: "2001:db8::1",
        reason: "test",
        durationMs: 86400000,
      });

      expect(manager.isBlocked("2001:db8::1")).toBe("test");
    });

    it("should update existing block", () => {
      manager.blockIp({
        ip: "192.168.1.100",
        reason: "first_reason",
        durationMs: 86400000,
      });

      manager.blockIp({
        ip: "192.168.1.100",
        reason: "second_reason",
        durationMs: 172800000,
      });

      expect(manager.isBlocked("192.168.1.100")).toBe("second_reason");
    });
  });

  describe("unblockIp", () => {
    it("should unblock a blocked IP", () => {
      manager.blockIp({
        ip: "192.168.1.100",
        reason: "test",
        durationMs: 86400000,
      });

      expect(manager.isBlocked("192.168.1.100")).toBe("test");

      manager.unblockIp("192.168.1.100");

      expect(manager.isBlocked("192.168.1.100")).toBeNull();
    });

    it("should handle unblocking non-existent IP", () => {
      expect(() => manager.unblockIp("192.168.1.100")).not.toThrow();
    });
  });

  describe("allowIp", () => {
    it("should add IP to allowlist", () => {
      manager.allowIp({
        ip: "192.168.1.200",
        reason: "trusted",
      });

      expect(manager.isAllowed("192.168.1.200")).toBe(true);
    });

    it("should add CIDR range to allowlist", () => {
      manager.allowIp({
        ip: "10.0.0.0/8",
        reason: "internal_network",
      });

      expect(manager.isAllowed("10.5.10.20")).toBe(true);
      expect(manager.isAllowed("11.0.0.1")).toBe(false);
    });

    it("should handle Tailscale CGNAT range", () => {
      manager.allowIp({
        ip: "100.64.0.0/10",
        reason: "tailscale",
      });

      expect(manager.isAllowed("100.64.0.1")).toBe(true);
      expect(manager.isAllowed("100.127.255.254")).toBe(true);
      expect(manager.isAllowed("100.128.0.1")).toBe(false);
    });
  });

  describe("removeFromAllowlist", () => {
    it("should remove IP from allowlist", () => {
      manager.allowIp({
        ip: "192.168.1.200",
        reason: "trusted",
      });

      expect(manager.isAllowed("192.168.1.200")).toBe(true);

      manager.removeFromAllowlist("192.168.1.200");

      expect(manager.isAllowed("192.168.1.200")).toBe(false);
    });

    it("should remove CIDR range from allowlist", () => {
      manager.allowIp({
        ip: "10.0.0.0/8",
        reason: "internal",
      });

      manager.removeFromAllowlist("10.0.0.0/8");

      expect(manager.isAllowed("10.5.10.20")).toBe(false);
    });
  });

  describe("isBlocked", () => {
    it("should return null for non-blocked IP", () => {
      expect(manager.isBlocked("192.168.1.100")).toBeNull();
    });

    it("should return block reason for blocked IP", () => {
      manager.blockIp({
        ip: "192.168.1.100",
        reason: "brute_force",
        durationMs: 86400000,
      });

      expect(manager.isBlocked("192.168.1.100")).toBe("brute_force");
    });

    it("should return null for expired blocks", () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      manager.blockIp({
        ip: "192.168.1.100",
        reason: "test",
        durationMs: 60000, // 1 minute
      });

      expect(manager.isBlocked("192.168.1.100")).toBe("test");

      // Advance past expiration
      vi.advanceTimersByTime(61000);

      expect(manager.isBlocked("192.168.1.100")).toBeNull();

      vi.useRealTimers();
    });

    it("should prioritize allowlist over blocklist", () => {
      manager.blockIp({
        ip: "192.168.1.100",
        reason: "test",
        durationMs: 86400000,
      });

      manager.allowIp({
        ip: "192.168.1.100",
        reason: "override",
      });

      expect(manager.isBlocked("192.168.1.100")).toBeNull();
    });
  });

  describe("isAllowed", () => {
    it("should return false for non-allowlisted IP", () => {
      expect(manager.isAllowed("192.168.1.100")).toBe(false);
    });

    it("should return true for allowlisted IP", () => {
      manager.allowIp({
        ip: "192.168.1.100",
        reason: "trusted",
      });

      expect(manager.isAllowed("192.168.1.100")).toBe(true);
    });

    it("should match IP in CIDR range", () => {
      manager.allowIp({
        ip: "192.168.0.0/16",
        reason: "local_network",
      });

      expect(manager.isAllowed("192.168.1.100")).toBe(true);
      expect(manager.isAllowed("192.168.255.255")).toBe(true);
      expect(manager.isAllowed("192.169.0.1")).toBe(false);
    });

    it("should match localhost variations", () => {
      manager.allowIp({
        ip: "127.0.0.0/8",
        reason: "localhost",
      });

      expect(manager.isAllowed("127.0.0.1")).toBe(true);
      expect(manager.isAllowed("127.0.0.2")).toBe(true);
      expect(manager.isAllowed("127.255.255.255")).toBe(true);
    });
  });

  describe("getBlocklist", () => {
    it("should return all blocked IPs", () => {
      manager.blockIp({
        ip: "192.168.1.1",
        reason: "test1",
        durationMs: 86400000,
      });

      manager.blockIp({
        ip: "192.168.1.2",
        reason: "test2",
        durationMs: 86400000,
      });

      const blocklist = manager.getBlockedIps();
      expect(blocklist).toHaveLength(2);
      expect(blocklist.map((b) => b.ip)).toContain("192.168.1.1");
      expect(blocklist.map((b) => b.ip)).toContain("192.168.1.2");
    });

    it("should include expiration timestamps", () => {
      const now = new Date();
      manager.blockIp({
        ip: "192.168.1.1",
        reason: "test",
        durationMs: 86400000,
      });

      const blocklist = manager.getBlockedIps();
      expect(blocklist[0]?.expiresAt).toBeDefined();
      expect(new Date(blocklist[0]!.expiresAt).getTime()).toBeGreaterThan(now.getTime());
    });
  });

  describe("getAllowlist", () => {
    it("should return all allowed IPs", () => {
      manager.allowIp({
        ip: "192.168.1.100",
        reason: "trusted1",
      });

      manager.allowIp({
        ip: "10.0.0.0/8",
        reason: "trusted2",
      });

      const allowlist = manager.getAllowedIps();
      expect(allowlist).toHaveLength(2);
      expect(allowlist.map((a) => a.ip)).toContain("192.168.1.100");
      expect(allowlist.map((a) => a.ip)).toContain("10.0.0.0/8");
    });
  });

  describe("CIDR matching", () => {
    it("should match /24 network", () => {
      manager.allowIp({
        ip: "192.168.1.0/24",
        reason: "test",
      });

      expect(manager.isAllowed("192.168.1.0")).toBe(true);
      expect(manager.isAllowed("192.168.1.100")).toBe(true);
      expect(manager.isAllowed("192.168.1.255")).toBe(true);
      expect(manager.isAllowed("192.168.2.1")).toBe(false);
    });

    it("should match /16 network", () => {
      manager.allowIp({
        ip: "10.20.0.0/16",
        reason: "test",
      });

      expect(manager.isAllowed("10.20.0.1")).toBe(true);
      expect(manager.isAllowed("10.20.255.254")).toBe(true);
      expect(manager.isAllowed("10.21.0.1")).toBe(false);
    });

    it("should match /8 network", () => {
      manager.allowIp({
        ip: "172.0.0.0/8",
        reason: "test",
      });

      expect(manager.isAllowed("172.16.0.1")).toBe(true);
      expect(manager.isAllowed("172.255.255.254")).toBe(true);
      expect(manager.isAllowed("173.0.0.1")).toBe(false);
    });

    it("should handle /32 single IP", () => {
      manager.allowIp({
        ip: "192.168.1.100/32",
        reason: "test",
      });

      expect(manager.isAllowed("192.168.1.100")).toBe(true);
      expect(manager.isAllowed("192.168.1.101")).toBe(false);
    });
  });

  describe("integration scenarios", () => {
    it("should handle mixed blocklist and allowlist", () => {
      // Block entire subnet
      manager.blockIp({
        ip: "192.168.1.0/24",
        reason: "suspicious_network",
        durationMs: 86400000,
      });

      // Allow specific IP from that subnet
      manager.allowIp({
        ip: "192.168.1.100",
        reason: "known_good",
      });

      // Blocked IP from subnet
      expect(manager.isBlocked("192.168.1.50")).toBe("suspicious_network");

      // Allowed IP overrides block
      expect(manager.isBlocked("192.168.1.100")).toBeNull();
    });

    it("should handle automatic cleanup of expired blocks", () => {
      vi.useFakeTimers();

      manager.blockIp({
        ip: "192.168.1.1",
        reason: "short_block",
        durationMs: 60000,
      });

      manager.blockIp({
        ip: "192.168.1.2",
        reason: "long_block",
        durationMs: 86400000,
      });

      // Both blocked initially
      expect(manager.isBlocked("192.168.1.1")).toBe("short_block");
      expect(manager.isBlocked("192.168.1.2")).toBe("long_block");

      // Advance past short block expiration
      vi.advanceTimersByTime(61000);

      // Short block expired
      expect(manager.isBlocked("192.168.1.1")).toBeNull();
      // Long block still active
      expect(manager.isBlocked("192.168.1.2")).toBe("long_block");

      vi.useRealTimers();
    });
  });
});
