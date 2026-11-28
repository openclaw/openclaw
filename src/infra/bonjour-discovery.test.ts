import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as processExec from "../process/exec.js";
import {
  discoverGatewayBeacons,
  type GatewayBonjourBeacon,
  resolveGatewayDiscoveryEndpoint,
} from "./bonjour-discovery.js";

const WIDE_AREA_DOMAIN = "openclaw.internal.";

function mockCommands(
  platform: NodeJS.Platform,
  stdout:
    | Record<string, string>
    | ((...args: Parameters<typeof processExec.runCommandWithTimeout>) => string),
) {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
  const read = (...args: Parameters<typeof processExec.runCommandWithTimeout>) => {
    const value = typeof stdout === "function" ? stdout(...args) : stdout[args[0].join(" ")];
    if (value === undefined) {
      throw new Error(`unexpected argv: ${args[0].join(" ")}`);
    }
    return value;
  };
  return vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (...args) => ({
    stdout: read(...args),
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
  }));
}

function getOnlyBeacon(beacons: readonly GatewayBonjourBeacon[]): GatewayBonjourBeacon {
  expect(beacons).toHaveLength(1);
  const beacon = beacons[0];
  if (!beacon) {
    throw new Error("Expected one beacon");
  }
  return beacon;
}

describe("bonjour-discovery", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_WIDE_AREA_DOMAIN", "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("discovers beacons on darwin across local + wide-area domains", async () => {
    const studioInstance = "Peter’s Mac Studio Gateway";
    const run = mockCommands("darwin", {
      "dns-sd -B _openclaw-gw._tcp local.":
        "Add 2 3 local. _openclaw-gw._tcp. Peter\\226\\128\\153s Mac Studio Gateway\nAdd 2 3 local. _openclaw-gw._tcp. Laptop Gateway\n",
      [`dns-sd -B _openclaw-gw._tcp ${WIDE_AREA_DOMAIN}`]: `Add 2 3 ${WIDE_AREA_DOMAIN} _openclaw-gw._tcp. Tailnet Gateway\n`,
      [`dns-sd -L ${studioInstance} _openclaw-gw._tcp local.`]: `${studioInstance}._openclaw-gw._tcp. can be reached at studio.local:18789\ntxtvers=1 displayName=Peter\\226\\128\\153s\\032Mac\\032Studio lanHost=studio.local gatewayPort=18789 sshPort=22\n`,
      "dns-sd -L Laptop Gateway _openclaw-gw._tcp local.":
        "Laptop Gateway._openclaw-gw._tcp. can be reached at laptop.local:18789\ntxtvers=1 displayName=Laptop lanHost=laptop.local gatewayPort=18789 sshPort=22\n",
      [`dns-sd -L Tailnet Gateway _openclaw-gw._tcp ${WIDE_AREA_DOMAIN}`]:
        "Tailnet Gateway._openclaw-gw._tcp. can be reached at tailnet.local:18789\ntxtvers=1 displayName=Tailnet lanHost=tailnet.local gatewayPort=18789 sshPort=22 tailnetDns=studio.tailnet.ts.net\n",
    });

    const beacons = await discoverGatewayBeacons({
      timeoutMs: 1234,
      wideAreaDomain: WIDE_AREA_DOMAIN,
    });

    expect(beacons).toHaveLength(3);
    expect(beacons.find((item) => item.instanceName === studioInstance)).toMatchObject({
      displayName: "Peter’s Mac Studio",
      txt: { displayName: "Peter’s Mac Studio" },
    });
    expect(beacons.map((b) => b.domain)).toEqual(
      expect.arrayContaining(["local.", WIDE_AREA_DOMAIN]),
    );

    const browseCalls = run.mock.calls.filter(([argv]) => argv[0] === "dns-sd" && argv[1] === "-B");
    expect(
      new Set(
        browseCalls.map(([, options]) =>
          typeof options === "number" ? options : options.timeoutMs,
        ),
      ),
    ).toEqual(new Set([1234]));
  });

  it.each([
    {
      name: "removal before browse completion",
      events: [
        "12:00:00.000 Add 2 3 local. _openclaw-gw._tcp. Retired Gateway",
        "12:00:00.001 Rmv 0 3 local. _openclaw-gw._tcp. Retired Gateway",
        "12:00:00.002 Add 2 3 local. _openclaw-gw._tcp. Active Gateway",
      ],
      expected: ["Active Gateway"],
    },
    {
      name: "removal followed by re-addition",
      events: [
        "Add 2 3 local. _openclaw-gw._tcp. Repeated Gateway",
        "Rmv 0 3 local. _openclaw-gw._tcp. Repeated Gateway",
        "Add 2 3 local. _openclaw-gw._tcp. Repeated Gateway",
      ],
      expected: ["Repeated Gateway"],
    },
    {
      name: "removal on only one interface",
      events: [
        "Add 2 3 local. _openclaw-gw._tcp. Shared Gateway",
        "Add 2 5 local. _openclaw-gw._tcp. Shared Gateway",
        "Rmv 0 3 local. _openclaw-gw._tcp. Shared Gateway",
      ],
      expected: ["Shared Gateway"],
    },
    {
      name: "removal on another domain",
      events: [
        "Add 2 3 local. _openclaw-gw._tcp. Shared Gateway",
        "Rmv 0 3 other.example. _openclaw-gw._tcp. Shared Gateway",
      ],
      expected: ["Shared Gateway"],
    },
    {
      name: "removal using a decoded instance name",
      events: [
        "Add 2 3 local. _openclaw-gw._tcp. Lab\\226\\128\\153s\\032Gateway",
        "Rmv 0 3 local. _openclaw-gw._tcp. Lab’s Gateway",
      ],
      expected: [],
    },
    {
      name: "removal-only event with Add in the instance name",
      events: ["Rmv 0 3 local. _openclaw-gw._tcp. Address Gateway"],
      expected: [],
    },
  ])("resolves only active Darwin instances after $name", async ({ events, expected }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const resolved: string[] = [];
    vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (argv) => {
      if (argv[0] === "dns-sd" && argv[1] === "-B") {
        return commandResult(events.join("\n"));
      }
      if (argv[0] === "dns-sd" && argv[1] === "-L") {
        const instance = argv[2] ?? "";
        resolved.push(instance);
        return commandResult(
          `${instance}._openclaw-gw._tcp. can be reached at gateway.local:18789`,
        );
      }
      throw new Error(`unexpected argv: ${argv.join(" ")}`);
    });

    const beacons = await discoverGatewayBeacons();
    expect(resolved).toEqual(expected);
    expect(beacons.map((beacon) => beacon.instanceName)).toEqual(expected);
  });

  it("shares the caller deadline across DNS-SD resolutions and fallback discovery", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const budgets: number[] = [];
    const run = mockCommands("darwin", (argv, options) => {
      const timeoutMs = typeof options === "number" ? options : options.timeoutMs;
      if (argv[1] === "-B") {
        if (argv[3] !== "local.") {
          return "";
        }
        now = 100;
        return ["First", "Second", "Third"]
          .map((name) => `Add 2 3 local. _openclaw-gw._tcp. ${name}`)
          .join("\n");
      }
      if (argv[1] === "-L") {
        budgets.push(timeoutMs ?? 0);
        now += 200;
        return `${argv[2]} can be reached at gateway.local:18789`;
      }
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    });

    const beacons = await discoverGatewayBeacons({
      timeoutMs: 500,
      deadlineMs: 500,
      wideAreaDomain: WIDE_AREA_DOMAIN,
    });

    expect(beacons.map((beacon) => beacon.instanceName)).toEqual(["First", "Second"]);
    expect(budgets).toEqual([400, 200]);
    expect(run.mock.calls.every(([argv]) => argv[0] === "dns-sd")).toBe(true);
  });

  it.each(["darwin", "linux"] as const)(
    "rejects invalid advertised ports on %s",
    async (platform) => {
      mockCommands(platform, (argv) => {
        const domain = argv[3] ?? "";
        const txt =
          "txtvers=1 displayName=Broken gatewayPort=70000 sshPort=22x gatewayTls=yes gatewayTlsSha256=synthetic role=gateway transport=gateway";
        if (argv[0] === "avahi-browse") {
          return `= eth0 IPv4 Broken Gateway _openclaw-gw._tcp local.\n hostname = [broken.local]\n port = [70000]\n txt = [${txt
            .split(" ")
            .map((token) => `"${token}"`)
            .join(" ")}]`;
        }
        if (argv[0] === "dns-sd" && argv[1] === "-B" && domain === "local.") {
          return "Add 2 3 local. _openclaw-gw._tcp. Broken Gateway\n";
        }

        if (argv[0] === "dns-sd" && argv[1] === "-L") {
          return `Broken Gateway._openclaw-gw._tcp. can be reached at broken.local:18789abc\n${txt}\n`;
        }

        throw new Error(`unexpected argv: ${argv.join(" ")}`);
      });

      const beacon = getOnlyBeacon(await discoverGatewayBeacons({ timeoutMs: 800 }));
      expect(beacon).toMatchObject({
        host: "broken.local",
        port: undefined,
        gatewayPort: undefined,
        sshPort: undefined,
        gatewayTls: true,
        gatewayTlsFingerprintSha256: "synthetic",
        role: "gateway",
        transport: "gateway",
      });
      expect(resolveGatewayDiscoveryEndpoint(beacon)).toBeNull();
    },
  );

  it("falls back to tailnet DNS probing for wide-area when split DNS is not configured", async () => {
    const zone = WIDE_AREA_DOMAIN.replace(/\.$/, "");
    const serviceBase = `_openclaw-gw._tcp.${zone}`;
    const studioService = `studio-gateway.${serviceBase}`;

    const dig = "dig +short +time=1 +tries=1 @100.123.224.76";
    mockCommands("darwin", {
      "dns-sd -B _openclaw-gw._tcp local.": "",
      [`dns-sd -B _openclaw-gw._tcp ${WIDE_AREA_DOMAIN}`]: "",
      "tailscale status --json": JSON.stringify({
        Self: { TailscaleIPs: ["100.69.232.64"] },
        Peer: { "peer-1": { TailscaleIPs: ["100.123.224.76"] } },
      }),
      [`${dig} ${serviceBase} PTR`]: `${studioService}.\n`,
      [`${dig} ${studioService} SRV`]: `0 0 18789 studio.${zone}.\n`,
      [`${dig} ${studioService} TXT`]:
        '"displayName=Studio" "gatewayPort=18789" "transport=gateway" "sshPort=22" "tailnetDns=peters-mac-studio-1.sheep-coho.ts.net" "cliPath=/opt/homebrew/bin/openclaw" ',
    });

    const beacons = await discoverGatewayBeacons({
      timeoutMs: 1200,
      wideAreaDomain: WIDE_AREA_DOMAIN,
    });

    const beacon = getOnlyBeacon(beacons);
    expect(beacon).toMatchObject({
      domain: WIDE_AREA_DOMAIN,
      instanceName: "studio-gateway",
      displayName: "Studio",
      host: `studio.${zone}`,
      port: 18789,
      gatewayPort: 18789,
      sshPort: 22,
      tailnetDns: "peters-mac-studio-1.sheep-coho.ts.net",
      cliPath: "/opt/homebrew/bin/openclaw",
    });
  });
});
