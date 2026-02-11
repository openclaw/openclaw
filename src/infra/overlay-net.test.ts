import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import { pickOverlayIPv4 } from "./overlay-net.js";

function iface(
  address: string,
  family: "IPv4" | "IPv6" = "IPv4",
  internal = false,
): os.NetworkInterfaceInfo {
  return { address, family, internal, netmask: "", mac: "", cidr: null } as os.NetworkInterfaceInfo;
}

describe("pickOverlayIPv4", () => {
  it("detects ZeroTier interface by zt prefix", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      lo0: [iface("127.0.0.1", "IPv4", true)],
      zt0: [iface("10.147.20.1")],
    });
    expect(pickOverlayIPv4("zt")).toBe("10.147.20.1");
  });

  it("detects WireGuard interface by wg prefix", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      lo0: [iface("127.0.0.1", "IPv4", true)],
      wg0: [iface("10.0.0.2")],
    });
    expect(pickOverlayIPv4("wg")).toBe("10.0.0.2");
  });

  it("detects Nebula interface by nebula prefix", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      lo0: [iface("127.0.0.1", "IPv4", true)],
      nebula1: [iface("10.42.0.5")],
    });
    expect(pickOverlayIPv4("nebula")).toBe("10.42.0.5");
  });

  it("auto-detects Tailscale IP in CGNAT range without hint", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      lo0: [iface("127.0.0.1", "IPv4", true)],
      utun9: [iface("100.100.1.2")],
    });
    expect(pickOverlayIPv4()).toBe("100.100.1.2");
  });

  it("auto-detects ZeroTier when no Tailscale present", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      lo0: [iface("127.0.0.1", "IPv4", true)],
      eth0: [iface("192.168.1.10")],
      zt0: [iface("10.147.20.1")],
    });
    expect(pickOverlayIPv4()).toBe("10.147.20.1");
  });

  it("auto-detects WireGuard when no Tailscale or ZeroTier present", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      lo0: [iface("127.0.0.1", "IPv4", true)],
      eth0: [iface("192.168.1.10")],
      wg0: [iface("10.0.0.3")],
    });
    expect(pickOverlayIPv4()).toBe("10.0.0.3");
  });

  it("interfaceHint takes precedence over auto-detection", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      utun9: [iface("100.100.1.2")],
      wg0: [iface("10.0.0.3")],
    });
    // Even though Tailscale IP exists, hint forces WireGuard
    expect(pickOverlayIPv4("wg")).toBe("10.0.0.3");
  });

  it("returns undefined when nothing matches", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      lo0: [iface("127.0.0.1", "IPv4", true)],
      eth0: [iface("192.168.1.10")],
    });
    expect(pickOverlayIPv4()).toBeUndefined();
  });

  it("returns undefined when hint matches no interface", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      lo0: [iface("127.0.0.1", "IPv4", true)],
      eth0: [iface("192.168.1.10")],
    });
    expect(pickOverlayIPv4("zt")).toBeUndefined();
  });

  it("skips internal interfaces", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      zt0: [iface("10.147.20.1", "IPv4", true)],
    });
    expect(pickOverlayIPv4("zt")).toBeUndefined();
  });

  it("skips IPv6 addresses when looking for IPv4", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      wg0: [iface("fe80::1", "IPv6")],
    });
    expect(pickOverlayIPv4("wg")).toBeUndefined();
  });
});
