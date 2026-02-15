import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isTrustedProxyAddress,
  pickPrimaryLanIPv4,
  resolveGatewayClientIp,
  resolveGatewayListenHosts,
  resolveTrustedProxies,
} from "./net.js";

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

describe("isTrustedProxyAddress", () => {
  it("matches exact proxy IPs (including IPv4-mapped)", () => {
    expect(isTrustedProxyAddress("127.0.0.1", ["127.0.0.1"])).toBe(true);
    expect(isTrustedProxyAddress("::ffff:127.0.0.1", ["127.0.0.1"])).toBe(true);
    expect(isTrustedProxyAddress("127.0.0.1", ["::ffff:127.0.0.1"])).toBe(true);
    expect(isTrustedProxyAddress("127.0.0.1", ["10.0.0.5"])).toBe(false);
  });

  it("matches IPv4 CIDR ranges", () => {
    expect(isTrustedProxyAddress("100.64.0.7", ["100.64.0.0/10"])).toBe(true);
    expect(isTrustedProxyAddress("100.127.255.254", ["100.64.0.0/10"])).toBe(true);
    expect(isTrustedProxyAddress("100.128.0.1", ["100.64.0.0/10"])).toBe(false);
  });

  it("matches IPv6 CIDR ranges", () => {
    expect(isTrustedProxyAddress("fd7a:115c:a1e0::1", ["fd7a:115c:a1e0::/48"])).toBe(true);
    expect(isTrustedProxyAddress("fd7a:115c:a1e1::1", ["fd7a:115c:a1e0::/48"])).toBe(false);
  });
});

describe("resolveGatewayClientIp", () => {
  it("uses forwarded client IP only when remote is trusted (CIDR)", () => {
    expect(
      resolveGatewayClientIp({
        remoteAddr: "100.64.0.7",
        forwardedFor: "203.0.113.9",
        trustedProxies: ["100.64.0.0/10"],
      }),
    ).toBe("203.0.113.9");

    expect(
      resolveGatewayClientIp({
        remoteAddr: "100.64.0.7",
        forwardedFor: "203.0.113.9",
        trustedProxies: [],
      }),
    ).toBe("100.64.0.7");
  });

  it("handles forwarded-for values with ports", () => {
    expect(
      resolveGatewayClientIp({
        remoteAddr: "10.0.0.5",
        forwardedFor: "203.0.113.9:1234, 198.51.100.1",
        trustedProxies: ["10.0.0.0/8"],
      }),
    ).toBe("203.0.113.9");
  });
});

describe("resolveTrustedProxies", () => {
  it("returns configured list unchanged when no env toggles", () => {
    const result = resolveTrustedProxies(["203.0.113.1", " 10.0.0.1 "], {});
    expect(result).toEqual(["203.0.113.1", "10.0.0.1"]);
  });

  it("adds private/railway ranges when enabled", () => {
    const env = { OPENCLAW_TRUST_PROXY_PRIVATE: "1" } as NodeJS.ProcessEnv;
    const result = resolveTrustedProxies(["203.0.113.1"], env);
    expect(result).toContain("203.0.113.1");
    expect(result).toContain("100.64.0.0/10");
    expect(result).toContain("10.0.0.0/8");
  });

  it("auto-enables private ranges on Railway", () => {
    const env = { RAILWAY_STATIC_URL: "https://example.up.railway.app" } as NodeJS.ProcessEnv;
    const result = resolveTrustedProxies([], env);
    expect(result).toContain("100.64.0.0/10");
  });
});
