import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import { resolveGatewayListenHosts, pickPrimaryLanIPv4 } from "./net.js";

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
  it("picks IPv4 from preferred interface", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      en0: [
        { address: "192.168.1.100", family: "IPv4", internal: false } as os.NetworkInterfaceInfo,
      ],
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true } as os.NetworkInterfaceInfo],
    });

    expect(pickPrimaryLanIPv4()).toBe("192.168.1.100");

    vi.restoreAllMocks();
  });

  it("returns undefined when no non-internal IPv4 is found", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true } as os.NetworkInterfaceInfo],
    });

    expect(pickPrimaryLanIPv4()).toBeUndefined();

    vi.restoreAllMocks();
  });

  it("picks from any interface if preferred ones are not available", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      customIface: [
        { address: "10.0.0.50", family: "IPv4", internal: false } as os.NetworkInterfaceInfo,
      ],
    });

    expect(pickPrimaryLanIPv4()).toBe("10.0.0.50");

    vi.restoreAllMocks();
  });
});
