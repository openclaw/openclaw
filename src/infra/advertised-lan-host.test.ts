// Tests route-aware LAN advertisement host selection.
import { describe, expect, it, vi } from "vitest";
import {
  listAdvertisedLanHostCandidates,
  parseLinuxDefaultRouteHints,
  parseMacOsDefaultRouteHints,
  parseWindowsDefaultRouteHints,
  resolveAdvertisedLanHost,
  selectAdvertisedLanHost,
  type AdvertisedLanHostCommandRunner,
} from "./advertised-lan-host.js";
import type { NetworkInterfacesSnapshot } from "./network-interfaces.js";

function ipv4(address: string, family: "IPv4" | 4 = "IPv4") {
  return {
    address,
    family,
    internal: false,
    netmask: "255.255.255.0",
    mac: "00:00:00:00:00:00",
    cidr: `${address}/24`,
  };
}

function createRouteRunner(stdout: string, code = 0): AdvertisedLanHostCommandRunner {
  return vi.fn(async () => ({
    code,
    stdout,
    stderr: "",
  }));
}

describe("advertised LAN host", () => {
  it("lists only private IPv4 candidates in OS order", () => {
    expect(
      listAdvertisedLanHostCandidates({
        tailscale0: [ipv4("100.64.0.9")],
        bridge: [ipv4("10.37.129.4")],
        ethernet: [ipv4("10.211.55.3", 4)],
        wifi: [ipv4("192.168.1.20")],
      } as NetworkInterfacesSnapshot),
    ).toEqual([
      { interfaceName: "bridge", address: "10.37.129.4", order: 0 },
      { interfaceName: "ethernet", address: "10.211.55.3", order: 1 },
      { interfaceName: "wifi", address: "192.168.1.20", order: 2 },
    ]);
  });

  it("prefers the default-route interface over the first private interface", () => {
    expect(
      selectAdvertisedLanHost(
        [
          { interfaceName: "Ethernet", address: "10.37.129.4", order: 0 },
          { interfaceName: "Ethernet 2", address: "10.211.55.3", order: 1 },
        ],
        [{ interfaceName: "Ethernet 2" }],
      ),
    ).toBe("10.211.55.3");
  });

  it("falls back to the original private-interface order when route hints do not match", () => {
    expect(
      selectAdvertisedLanHost(
        [
          { interfaceName: "Ethernet", address: "10.37.129.4", order: 0 },
          { interfaceName: "Ethernet 2", address: "10.211.55.3", order: 1 },
        ],
        [{ interfaceName: "Tailscale" }],
      ),
    ).toBe("10.37.129.4");
  });

  it("parses Windows default routes from Get-NetRoute JSON", () => {
    expect(
      parseWindowsDefaultRouteHints(
        '[{"InterfaceAlias":"Ethernet 2","RouteMetric":0},{"InterfaceAlias":"Ethernet","RouteMetric":256}]',
      ),
    ).toEqual([{ interfaceName: "ethernet 2" }, { interfaceName: "ethernet" }]);
  });

  it("sorts Windows default routes by effective metric", () => {
    expect(
      parseWindowsDefaultRouteHints(
        JSON.stringify([
          { InterfaceAlias: "Ethernet", RouteMetric: 1, InterfaceMetric: 1000 },
          { InterfaceAlias: "Ethernet 2", RouteMetric: 100, InterfaceMetric: 1 },
        ]),
      ),
    ).toEqual([{ interfaceName: "ethernet 2" }, { interfaceName: "ethernet" }]);
  });

  it("parses macOS and Linux default route interfaces", () => {
    expect(parseMacOsDefaultRouteHints("   route to: default\ninterface: en9\n")).toEqual([
      { interfaceName: "en9" },
    ]);
    expect(
      parseLinuxDefaultRouteHints(
        "default via 192.168.1.1 dev wlan0 proto dhcp metric 600\ndefault via 10.0.0.1 dev eth0 metric 1000",
      ),
    ).toEqual([{ interfaceName: "wlan0" }, { interfaceName: "eth0" }]);
  });

  it("uses the Windows default-route alias for the advertised host", async () => {
    const runner = createRouteRunner(
      '{"InterfaceAlias":"Ethernet 2","RouteMetric":0,"InterfaceMetric":25}',
    );

    await expect(
      resolveAdvertisedLanHost({
        platform: "win32",
        runCommandWithTimeout: runner,
        networkInterfaces: () =>
          ({
            Ethernet: [ipv4("10.37.129.4")],
            "Ethernet 2": [ipv4("10.211.55.3")],
          }) as NetworkInterfacesSnapshot,
      }),
    ).resolves.toBe("10.211.55.3");
    expect(runner).toHaveBeenCalledWith(
      [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        expect.stringContaining("Get-NetRoute"),
      ],
      { timeoutMs: 3_000, maxOutputBytes: 16 * 1024 },
    );
  });

  it("fails open to first private IPv4 when route probing times out", async () => {
    const runner: AdvertisedLanHostCommandRunner = vi.fn(async () => ({
      code: null,
      stdout: "",
      stderr: "",
    }));

    await expect(
      resolveAdvertisedLanHost({
        platform: "win32",
        runCommandWithTimeout: runner,
        networkInterfaces: () =>
          ({
            Ethernet: [ipv4("10.37.129.4")],
            "Ethernet 2": [ipv4("10.211.55.3")],
          }) as NetworkInterfacesSnapshot,
      }),
    ).resolves.toBe("10.37.129.4");
  });
});
