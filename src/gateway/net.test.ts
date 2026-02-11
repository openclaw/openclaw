import fs from "node:fs";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetDockerCache,
  isDockerEnvironment,
  pickPrimaryLanIPv4,
  readDockerGatewayIp,
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

describe("isDockerEnvironment", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _resetDockerCache();
  });

  it("returns true when /.dockerenv exists", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    expect(isDockerEnvironment()).toBe(true);
  });

  it("returns false when /.dockerenv does not exist", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    expect(isDockerEnvironment()).toBe(false);
  });

  it("returns false when existsSync throws", () => {
    vi.spyOn(fs, "existsSync").mockImplementation(() => {
      throw new Error("permission denied");
    });
    expect(isDockerEnvironment()).toBe(false);
  });

  it("caches the result across calls", () => {
    const spy = vi.spyOn(fs, "existsSync").mockReturnValue(true);
    isDockerEnvironment();
    isDockerEnvironment();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("readDockerGatewayIp", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _resetDockerCache();
  });

  it("parses Docker Desktop gateway IP (192.168.65.1)", () => {
    // 192.168.65.1 in little-endian hex: 01 41 A8 C0 -> 0141A8C0
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      [
        "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT",
        "eth0\t00000000\t0141A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0",
      ].join("\n"),
    );
    expect(readDockerGatewayIp()).toBe("192.168.65.1");
  });

  it("parses standard Docker bridge gateway IP (172.17.0.1)", () => {
    // 172.17.0.1 in little-endian hex: 01 00 11 AC -> 010011AC
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      [
        "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT",
        "eth0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0",
        "eth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0",
      ].join("\n"),
    );
    expect(readDockerGatewayIp()).toBe("172.17.0.1");
  });

  it("parses 10.0.2.2 gateway (common in VMs)", () => {
    // 10.0.2.2 in little-endian hex: 02 02 00 0A -> 0202000A
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      [
        "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT",
        "eth0\t00000000\t0202000A\t0003\t0\t0\t0\t00000000\t0\t0\t0",
      ].join("\n"),
    );
    expect(readDockerGatewayIp()).toBe("10.0.2.2");
  });

  it("returns undefined when /proc/net/route is missing", () => {
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(readDockerGatewayIp()).toBeUndefined();
  });

  it("returns undefined when no default route exists", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      [
        "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT",
        "eth0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0",
      ].join("\n"),
    );
    expect(readDockerGatewayIp()).toBeUndefined();
  });

  it("returns undefined when gateway hex is malformed", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      [
        "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT",
        "eth0\t00000000\tBAD\t0003\t0\t0\t0\t00000000\t0\t0\t0",
      ].join("\n"),
    );
    expect(readDockerGatewayIp()).toBeUndefined();
  });

  it("caches the result across calls", () => {
    const spy = vi
      .spyOn(fs, "readFileSync")
      .mockReturnValue(
        [
          "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT",
          "eth0\t00000000\t0141A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0",
        ].join("\n"),
      );
    readDockerGatewayIp();
    readDockerGatewayIp();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
