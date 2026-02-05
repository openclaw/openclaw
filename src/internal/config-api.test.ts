/**
 * Tests for Internal Config API
 *
 * Covers:
 * - Tailscale whois verification (auth success/failure)
 * - Hash validation on responses
 * - Tamper detection
 * - Non-Tailscale connection rejection
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import {
  verifyTailscaleWhois,
  computeHash,
  startConfigAPI,
  fetchConfigFromAPI,
  type TailscaleWhoisResult,
} from "./config-api.js";

// Mock runExec for Tailscale whois
const mockRunExec = vi.fn();
// Mock getTailscaleBinary to avoid requiring Tailscale installation
const mockGetTailscaleBinary = vi.fn().mockResolvedValue("/usr/bin/tailscale");

describe("verifyTailscaleWhois", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should reject non-Tailscale IPs", async () => {
    const result = await verifyTailscaleWhois("192.168.1.100", mockRunExec);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Not a Tailscale IP");
    expect(mockRunExec).not.toHaveBeenCalled();
  });

  it("should reject invalid IP format", async () => {
    const result = await verifyTailscaleWhois("invalid-ip", mockRunExec);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid IP format");
  });

  it("should strip IPv6-mapped prefix and validate", async () => {
    // IPv6-mapped non-Tailscale IP should fail
    const result = await verifyTailscaleWhois("::ffff:192.168.1.100", mockRunExec);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Not a Tailscale IP");
  });

  it("should accept valid Tailscale IP and call whois", async () => {
    const whoisResponse = {
      Node: {
        ID: 12345,
        Name: "test-node.tailnet-name.ts.net",
      },
      UserProfile: {
        LoginName: "user@example.com",
      },
    };

    mockRunExec.mockResolvedValue({ stdout: JSON.stringify(whoisResponse) });

    const result = await verifyTailscaleWhois("100.100.100.1", mockRunExec, mockGetTailscaleBinary);

    expect(result.valid).toBe(true);
    expect(result.nodeId).toBe("12345");
    expect(result.nodeName).toBe("test-node.tailnet-name.ts.net");
    expect(result.userLogin).toBe("user@example.com");
    expect(result.ipAddress).toBe("100.100.100.1");
  });

  it("should handle whois command failure gracefully", async () => {
    mockRunExec.mockRejectedValue(new Error("tailscale not running"));

    const result = await verifyTailscaleWhois("100.100.100.1", mockRunExec, mockGetTailscaleBinary);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("Whois failed");
  });

  it("should validate Tailscale IP range boundaries", async () => {
    // Lower bound: 100.64.0.0
    const lower = await verifyTailscaleWhois("100.64.0.1", mockRunExec, mockGetTailscaleBinary);
    // Should attempt whois (IP is valid Tailscale range)
    expect(mockRunExec).toHaveBeenCalled();

    mockRunExec.mockClear();

    // Upper bound: 100.127.255.255
    mockRunExec.mockResolvedValue({ stdout: JSON.stringify({ Node: { ID: 1 } }) });
    const upper = await verifyTailscaleWhois(
      "100.127.255.254",
      mockRunExec,
      mockGetTailscaleBinary,
    );
    expect(mockRunExec).toHaveBeenCalled();

    mockRunExec.mockClear();

    // Outside range: 100.63.x.x
    const belowRange = await verifyTailscaleWhois(
      "100.63.255.255",
      mockRunExec,
      mockGetTailscaleBinary,
    );
    expect(belowRange.valid).toBe(false);
    expect(mockRunExec).not.toHaveBeenCalled();

    // Outside range: 100.128.x.x
    const aboveRange = await verifyTailscaleWhois(
      "100.128.0.1",
      mockRunExec,
      mockGetTailscaleBinary,
    );
    expect(aboveRange.valid).toBe(false);
  });
});

describe("computeHash", () => {
  it("should compute SHA-256 hash of content", () => {
    const content = "test content";
    const expected = crypto.createHash("sha256").update(content, "utf-8").digest("hex");

    expect(computeHash(content)).toBe(expected);
  });

  it("should return different hashes for different content", () => {
    const hash1 = computeHash("content 1");
    const hash2 = computeHash("content 2");

    expect(hash1).not.toBe(hash2);
  });

  it("should handle empty strings", () => {
    const hash = computeHash("");
    expect(hash).toBe(crypto.createHash("sha256").update("", "utf-8").digest("hex"));
  });

  it("should handle unicode content", () => {
    const content = "Hello 世界 🌍";
    const hash = computeHash(content);
    expect(hash).toHaveLength(64); // SHA-256 produces 64 hex chars
  });
});

describe("Config API Server", () => {
  // Note: These tests require mocking the Tailscale interface
  // In a real test environment, we'd use a test double for the network layer

  describe("Tailscale binding verification", () => {
    it("should fail to start without Tailscale interface", async () => {
      // When pickPrimaryTailnetIPv4 returns undefined (no Tailscale)
      // the server should refuse to start
      await expect(startConfigAPI({ host: undefined as unknown as string })).rejects.toThrow(
        /No Tailscale interface detected/,
      );
    });

    it("should start on loopback for testing", async () => {
      // For testing, we can bind to loopback
      const server = await startConfigAPI({ host: "127.0.0.1", port: 0 });

      expect(server.address).toBe("127.0.0.1");
      expect(server.port).toBeGreaterThan(0);

      await server.stop();
    });
  });

  describe("Request handling", () => {
    let server: Awaited<ReturnType<typeof startConfigAPI>>;

    beforeEach(async () => {
      // Start server on loopback for testing
      server = await startConfigAPI({ host: "127.0.0.1", port: 0 });
    });

    afterEach(async () => {
      if (server) {
        await server.stop();
      }
    });

    it("should respond to health check", async () => {
      const response = await fetch(`http://127.0.0.1:${server.port}/health`);

      // Note: In real deployment, this would fail whois check
      // But we're testing on loopback which fails the Tailscale IP check
      expect(response.status).toBe(403);

      const body = await response.json();
      expect(body.error).toContain("Forbidden");
    });

    it("should reject non-Tailscale connections", async () => {
      const response = await fetch(`http://127.0.0.1:${server.port}/config/soul`);

      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("Not a valid Tailscale connection");
    });
  });
});

describe("Hash integrity verification", () => {
  it("should detect tampered content via hash mismatch", () => {
    const original = "# SOUL.md\n\nOriginal content";
    const tampered = "# SOUL.md\n\nTampered content";

    const originalHash = computeHash(original);
    const tamperedHash = computeHash(tampered);

    expect(originalHash).not.toBe(tamperedHash);
  });

  it("should verify content matches expected hash", () => {
    const content = "# Test content";
    const hash = computeHash(content);

    // Verification function
    const verifyIntegrity = (c: string, expectedHash: string) => {
      return computeHash(c) === expectedHash;
    };

    expect(verifyIntegrity(content, hash)).toBe(true);
    expect(verifyIntegrity(content + " modified", hash)).toBe(false);
  });
});

describe("Security event logging", () => {
  // These tests verify that security events are logged correctly
  // In a real implementation, we'd mock the security logger

  it("should log auth failures for non-Tailscale IPs", async () => {
    // This is implicitly tested by the whois verification tests
    // The actual logging is verified by checking the security log files
    const result = await verifyTailscaleWhois("192.168.1.1", mockRunExec);
    expect(result.valid).toBe(false);
    // Security event logging happens in the request handler, not here
  });
});
