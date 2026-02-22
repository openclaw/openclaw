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
  it("normalizes IPv4/hostname and IPv6 host forms", () => {
    const cases = [
      { input: "localhost:18789", expected: "localhost" },
      { input: "127.0.0.1:18789", expected: "127.0.0.1" },
      { input: "[::1]:18789", expected: "::1" },
      { input: "::1", expected: "::1" },
    ] as const;
    for (const testCase of cases) {
      expect(resolveHostName(testCase.input), testCase.input).toBe(testCase.expected);
    }
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
  it("resolves listen hosts for non-loopback and loopback variants", async () => {
    const cases = [
      {
        name: "non-loopback host passthrough",
        host: "0.0.0.0",
        canBindToHost: async () => {
          throw new Error("should not be called");
        },
        expected: ["0.0.0.0"],
      },
      {
        name: "loopback with IPv6 available",
        host: "127.0.0.1",
        canBindToHost: async () => true,
        expected: ["127.0.0.1", "::1"],
      },
      {
        name: "loopback with IPv6 unavailable",
        host: "127.0.0.1",
        canBindToHost: async () => false,
        expected: ["127.0.0.1"],
      },
    ] as const;

    for (const testCase of cases) {
      const hosts = await resolveGatewayListenHosts(testCase.host, {
        canBindToHost: testCase.canBindToHost,
      });
      expect(hosts, testCase.name).toEqual(testCase.expected);
    }
  });
});

describe("pickPrimaryLanIPv4", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefers en0, then eth0, then any non-internal IPv4, otherwise undefined", () => {
    const cases = [
      {
        name: "prefers en0",
        interfaces: {
          lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true, netmask: "" }],
          en0: [{ address: "192.168.1.42", family: "IPv4", internal: false, netmask: "" }],
        },
        expected: "192.168.1.42",
      },
      {
        name: "falls back to eth0",
        interfaces: {
          lo: [{ address: "127.0.0.1", family: "IPv4", internal: true, netmask: "" }],
          eth0: [{ address: "10.0.0.5", family: "IPv4", internal: false, netmask: "" }],
        },
        expected: "10.0.0.5",
      },
      {
        name: "falls back to any non-internal interface",
        interfaces: {
          lo: [{ address: "127.0.0.1", family: "IPv4", internal: true, netmask: "" }],
          wlan0: [{ address: "172.16.0.99", family: "IPv4", internal: false, netmask: "" }],
        },
        expected: "172.16.0.99",
      },
      {
        name: "no non-internal interface",
        interfaces: {
          lo: [{ address: "127.0.0.1", family: "IPv4", internal: true, netmask: "" }],
        },
        expected: undefined,
      },
    ] as const;

    for (const testCase of cases) {
      vi.spyOn(os, "networkInterfaces").mockReturnValue(
        testCase.interfaces as unknown as ReturnType<typeof os.networkInterfaces>,
      );
      expect(pickPrimaryLanIPv4(), testCase.name).toBe(testCase.expected);
      vi.restoreAllMocks();
    }
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
  it("accepts secure websocket/loopback ws URLs and rejects unsafe inputs", () => {
    const cases = [
      { input: "wss://127.0.0.1:18789", expected: true },
      { input: "wss://localhost:18789", expected: true },
      { input: "wss://remote.example.com:18789", expected: true },
      { input: "wss://192.168.1.100:18789", expected: true },
      { input: "ws://127.0.0.1:18789", expected: true },
      { input: "ws://localhost:18789", expected: true },
      { input: "ws://[::1]:18789", expected: true },
      { input: "ws://127.0.0.42:18789", expected: true },
      { input: "ws://remote.example.com:18789", expected: false },
      { input: "ws://192.168.1.100:18789", expected: false },
      { input: "ws://10.0.0.5:18789", expected: false },
      { input: "ws://100.64.0.1:18789", expected: false },
      { input: "not-a-url", expected: false },
      { input: "", expected: false },
      { input: "http://127.0.0.1:18789", expected: false },
      { input: "https://127.0.0.1:18789", expected: false },
    ] as const;

    for (const testCase of cases) {
      expect(isSecureWebSocketUrl(testCase.input), testCase.input).toBe(testCase.expected);
    }
  });
});
