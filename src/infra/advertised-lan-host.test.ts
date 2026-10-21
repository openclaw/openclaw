import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAdvertisedLanHostCore } from "./advertised-lan-host.js";
import type { NetworkInterfacesSnapshot } from "./network-interfaces.js";

function ipv4(address: string, family: "IPv4" | 4 = "IPv4") {
  return { address, family, internal: false };
}
function interfacePair(
  first: string,
  second: string,
  address = "192.168.1.20",
  firstAddress = "10.37.129.4",
) {
  return { [first]: [ipv4(firstAddress)], [second]: [ipv4(address)] };
}
type RouteCase = {
  name: string;
  platform: NodeJS.Platform;
  interfaces: Record<string, ReturnType<typeof ipv4>[]>;
  stdout: string;
  expected: string;
  code?: number | null;
};

describe("advertised LAN host", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each<RouteCase>([
    {
      name: "uses the first private IPv4 candidate when route hints are unavailable",
      platform: "aix",
      interfaces: {
        tailscale0: [ipv4("100.64.0.9")],
        bridge: [ipv4("10.37.129.4")],
        ethernet: [ipv4("10.211.55.3", 4)],
        wifi: [ipv4("192.168.1.20")],
      },
      stdout: "",
      expected: "10.37.129.4",
    },
    {
      name: "uses the lowest-metric Windows default-route alias",
      platform: "win32",
      interfaces: interfacePair("Ethernet", "réseau-网卡", "10.211.55.3"),
      stdout: JSON.stringify([
        { InterfaceAlias: "Ethernet", RouteMetric: 1, InterfaceMetric: 1000 },
        { InterfaceAlias: "réseau-网卡", RouteMetric: 100, InterfaceMetric: 1 },
      ]),
      expected: "10.211.55.3",
    },
    {
      name: "falls back to interface order when Linux route hints do not match",
      platform: "linux",
      interfaces: interfacePair("ethernet", "wifi"),
      stdout: "default via 100.64.0.1 dev tailscale0 metric 10",
      expected: "10.37.129.4",
    },
    {
      name: "uses the macOS default-route interface",
      platform: "darwin",
      interfaces: interfacePair("en0", "en9", "10.37.129.4", "192.168.1.20"),
      stdout: "   route to: default\ninterface: en9\n",
      expected: "10.37.129.4",
    },
    {
      name: "uses the first Linux default-route interface",
      platform: "linux",
      interfaces: interfacePair("eth0", "wlan0"),
      stdout:
        "default via 192.168.1.1 dev wlan0 proto dhcp metric 600\ndefault via 10.0.0.1 dev eth0 metric 1000",
      expected: "192.168.1.20",
    },
    {
      name: "fails open to first private IPv4 when route probing times out",
      platform: "win32",
      interfaces: interfacePair("Ethernet", "Ethernet 2", "10.211.55.3"),
      stdout: "",
      code: null,
      expected: "10.37.129.4",
    },
  ])("$name", async ({ platform, interfaces, stdout, expected, code = 0 }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const runner = vi.fn(async () => ({ code, stdout, stderr: "" }));
    await expect(
      resolveAdvertisedLanHostCore({
        runCommandWithTimeout: runner,
        networkInterfaces: () => interfaces as NetworkInterfacesSnapshot,
      }),
    ).resolves.toBe(expected);
    if (platform === "aix") {
      expect(runner).not.toHaveBeenCalled();
    } else if (platform === "win32" && code === 0) {
      expect(runner).toHaveBeenCalledWith(
        [
          "powershell.exe",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          expect.stringMatching(
            /^\[Console\]::OutputEncoding=\[Text\.UTF8Encoding\]::new\(\$false\); Get-NetRoute/,
          ),
        ],
        { timeoutMs: 3_000, maxOutputBytes: 16 * 1024 },
      );
    }
  });
});
