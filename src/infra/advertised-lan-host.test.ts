import { afterEach, expect, it, vi } from "vitest";
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
type RouteCase = [
  platform: NodeJS.Platform,
  interfaces: Record<string, ReturnType<typeof ipv4>[]>,
  stdout: string,
  expected: string,
  code?: number | null,
];

afterEach(() => vi.restoreAllMocks());
it.each<RouteCase>([
  [
    "aix",
    {
      tailscale0: [ipv4("100.64.0.9")],
      bridge: [ipv4("10.37.129.4")],
      ethernet: [ipv4("10.211.55.3", 4)],
      wifi: [ipv4("192.168.1.20")],
    },
    "",
    "10.37.129.4",
  ],
  [
    "win32",
    interfacePair("Ethernet", "réseau-网卡", "10.211.55.3"),
    JSON.stringify([
      { InterfaceAlias: "Ethernet", RouteMetric: 1, InterfaceMetric: 1000 },
      { InterfaceAlias: "réseau-网卡", RouteMetric: 100, InterfaceMetric: 1 },
    ]),
    "10.211.55.3",
  ],
  [
    "linux",
    interfacePair("ethernet", "wifi"),
    "default via 100.64.0.1 dev tailscale0 metric 10",
    "10.37.129.4",
  ],
  [
    "darwin",
    interfacePair("en0", "en9", "10.37.129.4", "192.168.1.20"),
    "   route to: default\ninterface: en9\n",
    "10.37.129.4",
  ],
  [
    "linux",
    interfacePair("eth0", "wlan0"),
    "default via 192.168.1.1 dev wlan0 proto dhcp metric 600\ndefault via 10.0.0.1 dev eth0 metric 1000",
    "192.168.1.20",
  ],
  ["win32", interfacePair("Ethernet", "Ethernet 2", "10.211.55.3"), "", "10.37.129.4", null],
])(
  "selects the advertised host on %s with routes %s %s",
  async (platform, interfaces, stdout, expected, code = 0) => {
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
  },
);
