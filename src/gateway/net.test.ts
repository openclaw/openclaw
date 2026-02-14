import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isPrivateOrLoopbackAddress,
  pickPrimaryLanIPv4,
  resolveGatewayListenHosts,
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
