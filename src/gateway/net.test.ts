import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isPrivateNetworkAddress, pickPrimaryLanIPv4, resolveGatewayListenHosts } from "./net.js";

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

describe("isPrivateNetworkAddress", () => {
  it("accepts Docker bridge addresses (172.17.x.x)", () => {
    expect(isPrivateNetworkAddress("172.17.0.1")).toBe(true);
    expect(isPrivateNetworkAddress("172.17.0.2")).toBe(true);
  });

  it("accepts full 172.16.0.0/12 range", () => {
    expect(isPrivateNetworkAddress("172.16.0.1")).toBe(true);
    expect(isPrivateNetworkAddress("172.31.255.254")).toBe(true);
  });

  it("rejects 172.x outside /12 range", () => {
    expect(isPrivateNetworkAddress("172.15.0.1")).toBe(false);
    expect(isPrivateNetworkAddress("172.32.0.1")).toBe(false);
  });

  it("accepts 10.0.0.0/8 range", () => {
    expect(isPrivateNetworkAddress("10.0.0.1")).toBe(true);
    expect(isPrivateNetworkAddress("10.255.255.254")).toBe(true);
  });

  it("accepts 192.168.0.0/16 range", () => {
    expect(isPrivateNetworkAddress("192.168.0.1")).toBe(true);
    expect(isPrivateNetworkAddress("192.168.255.254")).toBe(true);
  });

  it("accepts IPv4-mapped IPv6 private addresses", () => {
    expect(isPrivateNetworkAddress("::ffff:172.17.0.1")).toBe(true);
    expect(isPrivateNetworkAddress("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateNetworkAddress("::ffff:192.168.1.1")).toBe(true);
  });

  it("rejects public IPs", () => {
    expect(isPrivateNetworkAddress("8.8.8.8")).toBe(false);
    expect(isPrivateNetworkAddress("203.0.113.1")).toBe(false);
  });

  it("rejects loopback (handled by isLoopbackAddress)", () => {
    expect(isPrivateNetworkAddress("127.0.0.1")).toBe(false);
  });

  it("returns false for undefined/empty/invalid", () => {
    expect(isPrivateNetworkAddress(undefined)).toBe(false);
    expect(isPrivateNetworkAddress("")).toBe(false);
    expect(isPrivateNetworkAddress("not-an-ip")).toBe(false);
    expect(isPrivateNetworkAddress("::1")).toBe(false);
  });
});
