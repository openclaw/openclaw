import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isPrivateOrLoopbackAddress,
  isSecureWebSocketUrl,
  isTrustedProxyAddress,
  pickPrimaryLanIPv4,
  resolveClientIp,
  resolveGatewayListenHosts,
  resolveHostName,
} from "./net.js";

describe("resolveHostName", () => {
  it("returns hostname without port for IPv4/hostnames", () => {
    expect(resolveHostName("localhost:18789")).toBe("localhost");
    expect(resolveHostName("127.0.0.1:18789")).toBe("127.0.0.1");
  });

  it("handles bracketed and unbracketed IPv6 loopback hosts", () => {
    expect(resolveHostName("[::1]:18789")).toBe("::1");
    expect(resolveHostName("::1")).toBe("::1");
  });
});

describe("isTrustedProxyAddress", () => {
  describe("exact IP matching", () => {
    it("returns true when IP matches exactly", () => {
      expect(isTrustedProxyAddress("192.168.1.1", ["192.168.1.1"])).toBe(true);
    });

    it("returns false when IP does not match", () => {
      expect(isTrustedProxyAddress("192.168.1.2", ["192.168.1.1"])).toBe(false);
    });

    it("returns true when IP matches one of multiple proxies", () => {
      expect(isTrustedProxyAddress("10.0.0.5", ["192.168.1.1", "10.0.0.5", "172.16.0.1"])).toBe(
        true,
      );
    });

    it("ignores surrounding whitespace in exact IP entries", () => {
      expect(isTrustedProxyAddress("10.0.0.5", [" 10.0.0.5 "])).toBe(true);
    });
  });

  describe("CIDR subnet matching", () => {
    it("returns true when IP is within /24 subnet", () => {
      expect(isTrustedProxyAddress("10.42.0.59", ["10.42.0.0/24"])).toBe(true);
      expect(isTrustedProxyAddress("10.42.0.1", ["10.42.0.0/24"])).toBe(true);
      expect(isTrustedProxyAddress("10.42.0.254", ["10.42.0.0/24"])).toBe(true);
    });

    it("returns false when IP is outside /24 subnet", () => {
      expect(isTrustedProxyAddress("10.42.1.1", ["10.42.0.0/24"])).toBe(false);
      expect(isTrustedProxyAddress("10.43.0.1", ["10.42.0.0/24"])).toBe(false);
    });

    it("returns true when IP is within /16 subnet", () => {
      expect(isTrustedProxyAddress("172.19.5.100", ["172.19.0.0/16"])).toBe(true);
      expect(isTrustedProxyAddress("172.19.255.255", ["172.19.0.0/16"])).toBe(true);
    });

    it("returns false when IP is outside /16 subnet", () => {
      expect(isTrustedProxyAddress("172.20.0.1", ["172.19.0.0/16"])).toBe(false);
    });

    it("returns true when IP is within /32 subnet (single IP)", () => {
      expect(isTrustedProxyAddress("10.42.0.0", ["10.42.0.0/32"])).toBe(true);
    });

    it("returns false when IP does not match /32 subnet", () => {
      expect(isTrustedProxyAddress("10.42.0.1", ["10.42.0.0/32"])).toBe(false);
    });

    it("handles mixed exact IPs and CIDR notation", () => {
      const proxies = ["192.168.1.1", "10.42.0.0/24", "172.19.0.0/16"];
      expect(isTrustedProxyAddress("192.168.1.1", proxies)).toBe(true); // exact match
      expect(isTrustedProxyAddress("10.42.0.59", proxies)).toBe(true); // CIDR match
      expect(isTrustedProxyAddress("172.19.5.100", proxies)).toBe(true); // CIDR match
      expect(isTrustedProxyAddress("10.43.0.1", proxies)).toBe(false); // no match
    });
  });

  describe("backward compatibility", () => {
    it("preserves exact IP matching behavior (no CIDR notation)", () => {
      // Old configs with exact IPs should work exactly as before
      expect(isTrustedProxyAddress("192.168.1.1", ["192.168.1.1"])).toBe(true);
      expect(isTrustedProxyAddress("192.168.1.2", ["192.168.1.1"])).toBe(false);
      expect(isTrustedProxyAddress("10.0.0.5", ["192.168.1.1", "10.0.0.5"])).toBe(true);
    });

    it("does NOT treat plain IPs as /32 CIDR (exact match only)", () => {
      // "10.42.0.1" without /32 should match ONLY that exact IP
      expect(isTrustedProxyAddress("10.42.0.1", ["10.42.0.1"])).toBe(true);
      expect(isTrustedProxyAddress("10.42.0.2", ["10.42.0.1"])).toBe(false);
      expect(isTrustedProxyAddress("10.42.0.59", ["10.42.0.1"])).toBe(false);
    });

    it("handles IPv4-mapped IPv6 addresses (existing normalizeIp behavior)", () => {
      // Existing normalizeIp() behavior should be preserved
      expect(isTrustedProxyAddress("::ffff:192.168.1.1", ["192.168.1.1"])).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("returns false when IP is undefined", () => {
      expect(isTrustedProxyAddress(undefined, ["192.168.1.1"])).toBe(false);
    });

    it("returns false when trustedProxies is undefined", () => {
      expect(isTrustedProxyAddress("192.168.1.1", undefined)).toBe(false);
    });

    it("returns false when trustedProxies is empty", () => {
      expect(isTrustedProxyAddress("192.168.1.1", [])).toBe(false);
    });

    it("returns false for invalid CIDR notation", () => {
      expect(isTrustedProxyAddress("10.42.0.59", ["10.42.0.0/33"])).toBe(false); // invalid prefix
      expect(isTrustedProxyAddress("10.42.0.59", ["10.42.0.0/-1"])).toBe(false); // negative prefix
      expect(isTrustedProxyAddress("10.42.0.59", ["invalid/24"])).toBe(false); // invalid IP
    });

    it("ignores surrounding whitespace in CIDR entries", () => {
      expect(isTrustedProxyAddress("10.42.0.59", [" 10.42.0.0/24 "])).toBe(true);
    });

    it("ignores blank trusted proxy entries", () => {
      expect(isTrustedProxyAddress("10.0.0.5", [" ", "\t"])).toBe(false);
      expect(isTrustedProxyAddress("10.0.0.5", [" ", "10.0.0.5", ""])).toBe(true);
    });
  });
});

describe("resolveClientIp", () => {
  it.each([
    {
      name: "returns remote IP when remote is not trusted proxy",
      remoteAddr: "203.0.113.10",
      forwardedFor: "10.0.0.2",
      trustedProxies: ["127.0.0.1"],
      expected: "203.0.113.10",
    },
    {
      name: "uses right-most untrusted X-Forwarded-For hop",
      remoteAddr: "127.0.0.1",
      forwardedFor: "198.51.100.99, 10.0.0.9, 127.0.0.1",
      trustedProxies: ["127.0.0.1"],
      expected: "10.0.0.9",
    },
    {
      name: "fails closed when all X-Forwarded-For hops are trusted proxies",
      remoteAddr: "127.0.0.1",
      forwardedFor: "127.0.0.1, ::1",
      trustedProxies: ["127.0.0.1", "::1"],
      expected: undefined,
    },
    {
      name: "fails closed when trusted proxy omits forwarding headers",
      remoteAddr: "127.0.0.1",
      trustedProxies: ["127.0.0.1"],
      expected: undefined,
    },
    {
      name: "ignores invalid X-Forwarded-For entries",
      remoteAddr: "127.0.0.1",
      forwardedFor: "garbage, 10.0.0.999",
      trustedProxies: ["127.0.0.1"],
      expected: undefined,
    },
    {
      name: "does not trust X-Real-IP by default",
      remoteAddr: "127.0.0.1",
      realIp: "[2001:db8::5]",
      trustedProxies: ["127.0.0.1"],
      expected: undefined,
    },
    {
      name: "uses X-Real-IP only when explicitly enabled",
      remoteAddr: "127.0.0.1",
      realIp: "[2001:db8::5]",
      trustedProxies: ["127.0.0.1"],
      allowRealIpFallback: true,
      expected: "2001:db8::5",
    },
    {
      name: "ignores invalid X-Real-IP even when fallback enabled",
      remoteAddr: "127.0.0.1",
      realIp: "not-an-ip",
      trustedProxies: ["127.0.0.1"],
      allowRealIpFallback: true,
      expected: undefined,
    },
  ])("$name", (testCase) => {
    const ip = resolveClientIp({
      remoteAddr: testCase.remoteAddr,
      forwardedFor: testCase.forwardedFor,
      realIp: testCase.realIp,
      trustedProxies: testCase.trustedProxies,
      allowRealIpFallback: testCase.allowRealIpFallback,
    });
    expect(ip).toBe(testCase.expected);
  });
});

describe("resolveGatewayListenHosts", () => {
  it("returns the input host when not loopback", async () => {
    const hosts = await resolveGatewayListenHosts("0.0.0.0", {
      canBindToHost: async () => {
        throw new Error("should not be called");
      },
    });
    expect(hosts).toEqual(["0.0.0.0"]);
  });

  it("adds ::1 when IPv6 loopback is available", async () => {
    const hosts = await resolveGatewayListenHosts("127.0.0.1", {
      canBindToHost: async () => true,
    });
    expect(hosts).toEqual(["127.0.0.1", "::1"]);
  });

  it("keeps only IPv4 loopback when IPv6 is unavailable", async () => {
    const hosts = await resolveGatewayListenHosts("127.0.0.1", {
      canBindToHost: async () => false,
    });
    expect(hosts).toEqual(["127.0.0.1"]);
  });
});

describe("pickPrimaryLanIPv4", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns en0 IPv4 address when available", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      lo0: [
        { address: "127.0.0.1", family: "IPv4", internal: true, netmask: "" },
      ] as unknown as os.NetworkInterfaceInfo[],
      en0: [
        { address: "192.168.1.42", family: "IPv4", internal: false, netmask: "" },
      ] as unknown as os.NetworkInterfaceInfo[],
    });
    expect(pickPrimaryLanIPv4()).toBe("192.168.1.42");
  });

  it("returns eth0 IPv4 address when en0 is absent", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      lo: [
        { address: "127.0.0.1", family: "IPv4", internal: true, netmask: "" },
      ] as unknown as os.NetworkInterfaceInfo[],
      eth0: [
        { address: "10.0.0.5", family: "IPv4", internal: false, netmask: "" },
      ] as unknown as os.NetworkInterfaceInfo[],
    });
    expect(pickPrimaryLanIPv4()).toBe("10.0.0.5");
  });

  it("falls back to any non-internal IPv4 interface", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      lo: [
        { address: "127.0.0.1", family: "IPv4", internal: true, netmask: "" },
      ] as unknown as os.NetworkInterfaceInfo[],
      wlan0: [
        { address: "172.16.0.99", family: "IPv4", internal: false, netmask: "" },
      ] as unknown as os.NetworkInterfaceInfo[],
    });
    expect(pickPrimaryLanIPv4()).toBe("172.16.0.99");
  });

  it("returns undefined when only internal interfaces exist", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      lo: [
        { address: "127.0.0.1", family: "IPv4", internal: true, netmask: "" },
      ] as unknown as os.NetworkInterfaceInfo[],
    });
    expect(pickPrimaryLanIPv4()).toBeUndefined();
  });
});

describe("isPrivateOrLoopbackAddress", () => {
  it("accepts loopback, private, link-local, and cgnat ranges", () => {
    const accepted = [
      "127.0.0.1",
      "::1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.0.1",
      "169.254.10.20",
      "100.64.0.1",
      "100.127.255.254",
      "::ffff:100.100.100.100",
      "fc00::1",
      "fd12:3456:789a::1",
      "fe80::1",
      "fe9a::1",
      "febb::1",
    ];
    for (const ip of accepted) {
      expect(isPrivateOrLoopbackAddress(ip)).toBe(true);
    }
  });

  it("rejects public addresses", () => {
    const rejected = ["1.1.1.1", "8.8.8.8", "172.32.0.1", "203.0.113.10", "2001:4860:4860::8888"];
    for (const ip of rejected) {
      expect(isPrivateOrLoopbackAddress(ip)).toBe(false);
    }
  });
});

describe("isSecureWebSocketUrl", () => {
  describe("wss:// (TLS) URLs", () => {
    it("returns true for wss:// regardless of host", () => {
      expect(isSecureWebSocketUrl("wss://127.0.0.1:18789")).toBe(true);
      expect(isSecureWebSocketUrl("wss://localhost:18789")).toBe(true);
      expect(isSecureWebSocketUrl("wss://remote.example.com:18789")).toBe(true);
      expect(isSecureWebSocketUrl("wss://192.168.1.100:18789")).toBe(true);
    });
  });

  describe("ws:// (plaintext) URLs", () => {
    it("returns true for ws:// to loopback addresses", () => {
      expect(isSecureWebSocketUrl("ws://127.0.0.1:18789")).toBe(true);
      expect(isSecureWebSocketUrl("ws://localhost:18789")).toBe(true);
      expect(isSecureWebSocketUrl("ws://[::1]:18789")).toBe(true);
      expect(isSecureWebSocketUrl("ws://127.0.0.42:18789")).toBe(true);
    });

    it("returns false for ws:// to non-loopback addresses (CWE-319)", () => {
      expect(isSecureWebSocketUrl("ws://remote.example.com:18789")).toBe(false);
      expect(isSecureWebSocketUrl("ws://192.168.1.100:18789")).toBe(false);
      expect(isSecureWebSocketUrl("ws://10.0.0.5:18789")).toBe(false);
      expect(isSecureWebSocketUrl("ws://100.64.0.1:18789")).toBe(false);
    });
  });

  describe("invalid URLs", () => {
    it("returns false for invalid URLs", () => {
      expect(isSecureWebSocketUrl("not-a-url")).toBe(false);
      expect(isSecureWebSocketUrl("")).toBe(false);
    });

    it("returns false for non-WebSocket protocols", () => {
      expect(isSecureWebSocketUrl("http://127.0.0.1:18789")).toBe(false);
      expect(isSecureWebSocketUrl("https://127.0.0.1:18789")).toBe(false);
    });
  });
});
