import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeNetworkInterfacesSnapshot } from "../test-helpers/network-interfaces.js";
import {
  isLocalishHost,
  isPrivateOrLoopbackAddress,
  isPrivateOrLoopbackHost,
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

describe("isLocalishHost", () => {
  it("accepts loopback and tailscale serve/funnel host headers", () => {
    const accepted = [
      "localhost",
      "127.0.0.1:18789",
      "[::1]:18789",
      "[::ffff:127.0.0.1]:18789",
      "gateway.tailnet.ts.net",
    ];
    for (const host of accepted) {
      expect(isLocalishHost(host), host).toBe(true);
    }
  });

  it("rejects non-local hosts", () => {
    const rejected = ["example.com", "192.168.1.10", "203.0.113.5:18789"];
    for (const host of rejected) {
      expect(isLocalishHost(host), host).toBe(false);
    }
  });
});

describe("isTrustedProxyAddress", () => {
  it.each([
    {
      name: "matches exact IP entries",
      ip: "192.168.1.1",
      trustedProxies: ["192.168.1.1"],
      expected: true,
    },
    {
      name: "rejects non-matching exact IP entries",
      ip: "192.168.1.2",
      trustedProxies: ["192.168.1.1"],
      expected: false,
    },
    {
      name: "matches one of multiple exact entries",
      ip: "10.0.0.5",
      trustedProxies: ["192.168.1.1", "10.0.0.5", "172.16.0.1"],
      expected: true,
    },
    {
      name: "ignores surrounding whitespace in exact IP entries",
      ip: "10.0.0.5",
      trustedProxies: [" 10.0.0.5 "],
      expected: true,
    },
    {
      name: "matches /24 CIDR entries",
      ip: "10.42.0.59",
      trustedProxies: ["10.42.0.0/24"],
      expected: true,
    },
    {
      name: "rejects IPs outside /24 CIDR entries",
      ip: "10.42.1.1",
      trustedProxies: ["10.42.0.0/24"],
      expected: false,
    },
    {
      name: "matches /16 CIDR entries",
      ip: "172.19.255.255",
      trustedProxies: ["172.19.0.0/16"],
      expected: true,
    },
    {
      name: "rejects IPs outside /16 CIDR entries",
      ip: "172.20.0.1",
      trustedProxies: ["172.19.0.0/16"],
      expected: false,
    },
    {
      name: "treats /32 as a single-IP CIDR",
      ip: "10.42.0.0",
      trustedProxies: ["10.42.0.0/32"],
      expected: true,
    },
    {
      name: "rejects non-matching /32 CIDR entries",
      ip: "10.42.0.1",
      trustedProxies: ["10.42.0.0/32"],
      expected: false,
    },
    {
      name: "handles mixed exact IP and CIDR entries",
      ip: "172.19.5.100",
      trustedProxies: ["192.168.1.1", "10.42.0.0/24", "172.19.0.0/16"],
      expected: true,
    },
    {
      name: "rejects IPs missing from mixed exact IP and CIDR entries",
      ip: "10.43.0.1",
      trustedProxies: ["192.168.1.1", "10.42.0.0/24", "172.19.0.0/16"],
      expected: false,
    },
    {
      name: "supports IPv6 CIDR notation",
      ip: "2001:db8::1234",
      trustedProxies: ["2001:db8::/32"],
      expected: true,
    },
    {
      name: "rejects IPv6 addresses outside the configured CIDR",
      ip: "2001:db9::1234",
      trustedProxies: ["2001:db8::/32"],
      expected: false,
    },
    {
      name: "preserves exact matching behavior for plain IP entries",
      ip: "10.42.0.59",
      trustedProxies: ["10.42.0.1"],
      expected: false,
    },
    {
      name: "normalizes IPv4-mapped IPv6 addresses",
      ip: "::ffff:192.168.1.1",
      trustedProxies: ["192.168.1.1"],
      expected: true,
    },
    {
      name: "returns false when IP is undefined",
      ip: undefined,
      trustedProxies: ["192.168.1.1"],
      expected: false,
    },
    {
      name: "returns false when trusted proxies are undefined",
      ip: "192.168.1.1",
      trustedProxies: undefined,
      expected: false,
    },
    {
      name: "returns false when trusted proxies are empty",
      ip: "192.168.1.1",
      trustedProxies: [],
      expected: false,
    },
    {
      name: "rejects invalid CIDR prefixes and addresses",
      ip: "10.42.0.59",
      trustedProxies: ["10.42.0.0/33", "10.42.0.0/-1", "invalid/24", "2001:db8::/129"],
      expected: false,
    },
    {
      name: "ignores surrounding whitespace in CIDR entries",
      ip: "10.42.0.59",
      trustedProxies: [" 10.42.0.0/24 "],
      expected: true,
    },
    {
      name: "ignores blank trusted proxy entries",
      ip: "10.0.0.5",
      trustedProxies: [" ", "10.0.0.5", ""],
      expected: true,
    },
    {
      name: "treats all-blank trusted proxy entries as no match",
      ip: "10.0.0.5",
      trustedProxies: [" ", "\t"],
      expected: false,
    },
  ])("$name", ({ ip, trustedProxies, expected }) => {
    expect(isTrustedProxyAddress(ip, trustedProxies)).toBe(expected);
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
      name: "ignores spoofed loopback X-Forwarded-For hops from trusted proxies",
      remoteAddr: "10.0.0.50",
      forwardedFor: "127.0.0.1",
      trustedProxies: ["10.0.0.0/8"],
      expected: undefined,
    },
    {
      name: "fails closed when all X-Forwarded-For hops are trusted proxies",
      remoteAddr: "127.0.0.1",
      forwardedFor: "127.0.0.1, ::1",
      trustedProxies: ["127.0.0.1", "::1"],
      expected: undefined,
    },
    {
      name: "fails closed when all non-loopback X-Forwarded-For hops are trusted proxies",
      remoteAddr: "10.0.0.50",
      forwardedFor: "10.0.0.2, 10.0.0.1",
      trustedProxies: ["10.0.0.0/8"],
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
        interfaces: makeNetworkInterfacesSnapshot({
          lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
          en0: [{ address: "192.168.1.42", family: "IPv4" }],
        }),
        expected: "192.168.1.42",
      },
      {
        name: "falls back to eth0",
        interfaces: makeNetworkInterfacesSnapshot({
          lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
          eth0: [{ address: "10.0.0.5", family: "IPv4" }],
        }),
        expected: "10.0.0.5",
      },
      {
        name: "falls back to any non-internal interface",
        interfaces: makeNetworkInterfacesSnapshot({
          lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
          wlan0: [{ address: "172.16.0.99", family: "IPv4" }],
        }),
        expected: "172.16.0.99",
      },
      {
        name: "no non-internal interface",
        interfaces: makeNetworkInterfacesSnapshot({
          lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        }),
        expected: undefined,
      },
    ] as const;

    for (const testCase of cases) {
      vi.spyOn(os, "networkInterfaces").mockReturnValue(testCase.interfaces);
      expect(pickPrimaryLanIPv4(), testCase.name).toBe(testCase.expected);
      vi.restoreAllMocks();
    }
  });

  it("returns undefined when interface discovery throws", () => {
    vi.spyOn(os, "networkInterfaces").mockImplementation(() => {
      throw new Error("uv_interface_addresses failed");
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

describe("isPrivateOrLoopbackHost", () => {
  it("accepts localhost", () => {
    expect(isPrivateOrLoopbackHost("localhost")).toBe(true);
  });

  it("accepts loopback addresses", () => {
    expect(isPrivateOrLoopbackHost("127.0.0.1")).toBe(true);
    expect(isPrivateOrLoopbackHost("::1")).toBe(true);
    expect(isPrivateOrLoopbackHost("[::1]")).toBe(true);
  });

  it("accepts RFC 1918 private addresses", () => {
    expect(isPrivateOrLoopbackHost("10.0.0.5")).toBe(true);
    expect(isPrivateOrLoopbackHost("10.42.1.100")).toBe(true);
    expect(isPrivateOrLoopbackHost("172.16.0.1")).toBe(true);
    expect(isPrivateOrLoopbackHost("172.31.255.254")).toBe(true);
    expect(isPrivateOrLoopbackHost("192.168.1.100")).toBe(true);
  });

  it("accepts CGNAT and link-local addresses", () => {
    expect(isPrivateOrLoopbackHost("100.64.0.1")).toBe(true);
    expect(isPrivateOrLoopbackHost("169.254.10.20")).toBe(true);
  });

  it("accepts IPv6 private addresses", () => {
    expect(isPrivateOrLoopbackHost("[fc00::1]")).toBe(true);
    expect(isPrivateOrLoopbackHost("[fd12:3456:789a::1]")).toBe(true);
    expect(isPrivateOrLoopbackHost("[fe80::1]")).toBe(true);
  });

  it("rejects unspecified IPv6 address (::)", () => {
    expect(isPrivateOrLoopbackHost("[::]")).toBe(false);
    expect(isPrivateOrLoopbackHost("::")).toBe(false);
    expect(isPrivateOrLoopbackHost("0:0::0")).toBe(false);
    expect(isPrivateOrLoopbackHost("[0:0::0]")).toBe(false);
    expect(isPrivateOrLoopbackHost("[0000:0000:0000:0000:0000:0000:0000:0000]")).toBe(false);
  });

  it("rejects multicast IPv6 addresses (ff00::/8)", () => {
    expect(isPrivateOrLoopbackHost("[ff02::1]")).toBe(false);
    expect(isPrivateOrLoopbackHost("[ff05::2]")).toBe(false);
    expect(isPrivateOrLoopbackHost("[ff0e::1]")).toBe(false);
  });

  it("rejects public addresses", () => {
    expect(isPrivateOrLoopbackHost("1.1.1.1")).toBe(false);
    expect(isPrivateOrLoopbackHost("8.8.8.8")).toBe(false);
    expect(isPrivateOrLoopbackHost("203.0.113.10")).toBe(false);
  });

  it("rejects empty/falsy input", () => {
    expect(isPrivateOrLoopbackHost("")).toBe(false);
  });
});

describe("isSecureWebSocketUrl", () => {
  it("defaults to loopback-only ws:// and rejects private/public remote ws://", () => {
    const cases = [
      // wss:// always accepted
      { input: "wss://127.0.0.1:18789", expected: true },
      { input: "wss://localhost:18789", expected: true },
      { input: "wss://remote.example.com:18789", expected: true },
      { input: "wss://192.168.1.100:18789", expected: true },
      // ws:// loopback accepted
      { input: "ws://127.0.0.1:18789", expected: true },
      { input: "ws://localhost:18789", expected: true },
      { input: "ws://[::1]:18789", expected: true },
      { input: "ws://127.0.0.42:18789", expected: true },
      // ws:// private/public remote addresses rejected by default
      { input: "ws://10.0.0.5:18789", expected: false },
      { input: "ws://10.42.1.100:18789", expected: false },
      { input: "ws://172.16.0.1:18789", expected: false },
      { input: "ws://172.31.255.254:18789", expected: false },
      { input: "ws://192.168.1.100:18789", expected: false },
      { input: "ws://169.254.10.20:18789", expected: false },
      { input: "ws://100.64.0.1:18789", expected: false },
      { input: "ws://[fc00::1]:18789", expected: false },
      { input: "ws://[fd12:3456:789a::1]:18789", expected: false },
      { input: "ws://[fe80::1]:18789", expected: false },
      { input: "ws://[::]:18789", expected: false },
      { input: "ws://[ff02::1]:18789", expected: false },
      // ws:// public addresses rejected
      { input: "ws://remote.example.com:18789", expected: false },
      { input: "ws://1.1.1.1:18789", expected: false },
      { input: "ws://8.8.8.8:18789", expected: false },
      { input: "ws://203.0.113.10:18789", expected: false },
      // invalid URLs
      { input: "not-a-url", expected: false },
      { input: "", expected: false },
      { input: "http://127.0.0.1:18789", expected: true },
      { input: "https://127.0.0.1:18789", expected: true },
      { input: "https://remote.example.com:18789", expected: true },
      { input: "http://remote.example.com:18789", expected: false },
    ] as const;

    for (const testCase of cases) {
      expect(isSecureWebSocketUrl(testCase.input), testCase.input).toBe(testCase.expected);
    }
  });

  it("allows private ws:// only when opt-in is enabled", () => {
    const allowedWhenOptedIn = [
      "ws://10.0.0.5:18789",
      "http://10.0.0.5:18789",
      "ws://172.16.0.1:18789",
      "ws://192.168.1.100:18789",
      "ws://100.64.0.1:18789",
      "ws://169.254.10.20:18789",
      "ws://[fc00::1]:18789",
      "ws://[fe80::1]:18789",
      "ws://gateway.private.example:18789",
    ];

    for (const input of allowedWhenOptedIn) {
      expect(isSecureWebSocketUrl(input, { allowPrivateWs: true }), input).toBe(true);
    }
  });

  it("still rejects ws:// public IP literals when opt-in is enabled", () => {
    const publicIpWsUrls = ["ws://1.1.1.1:18789", "ws://8.8.8.8:18789", "ws://203.0.113.10:18789"];

    for (const input of publicIpWsUrls) {
      expect(isSecureWebSocketUrl(input, { allowPrivateWs: true }), input).toBe(false);
    }
  });

  it("still rejects non-unicast IPv6 ws:// even when opt-in is enabled", () => {
    const disallowedWhenOptedIn = [
      "ws://[::]:18789",
      "ws://[0:0::0]:18789",
      "ws://[ff02::1]:18789",
    ];

    for (const input of disallowedWhenOptedIn) {
      expect(isSecureWebSocketUrl(input, { allowPrivateWs: true }), input).toBe(false);
    }
  });
});
