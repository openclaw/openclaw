// Covers Bonjour gateway beacon parsing and endpoint resolution.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as processExec from "../process/exec.js";
import {
  discoverGatewayBeacons,
  type GatewayBonjourBeacon,
  resolveGatewayDiscoveryEndpoint,
} from "./bonjour-discovery.js";

const WIDE_AREA_DOMAIN = "openclaw.internal.";

function commandResult(
  stdout: string,
): Awaited<ReturnType<typeof processExec.runCommandWithTimeout>> {
  return { stdout, stderr: "", code: 0, signal: null, killed: false, termination: "exit" };
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
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const calls: Array<{ argv: string[]; timeoutMs?: number }> = [];
    const studioInstance = "Peter’s Mac Studio Gateway";

    vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      calls.push({ argv, timeoutMs: typeof options === "number" ? options : options.timeoutMs });
      const domain = argv[3] ?? "";

      if (argv[0] === "dns-sd" && argv[1] === "-B") {
        if (domain === "local.") {
          return commandResult(
            "Add 2 3 local. _openclaw-gw._tcp. Peter\\226\\128\\153s Mac Studio Gateway\nAdd 2 3 local. _openclaw-gw._tcp. Laptop Gateway\n",
          );
        }
        if (domain === WIDE_AREA_DOMAIN) {
          return commandResult(`Add 2 3 ${WIDE_AREA_DOMAIN} _openclaw-gw._tcp. Tailnet Gateway\n`);
        }
      }

      if (argv[0] === "dns-sd" && argv[1] === "-L") {
        const instance = argv[2] ?? "";
        const host =
          instance === studioInstance
            ? "studio.local"
            : instance === "Laptop Gateway"
              ? "laptop.local"
              : "tailnet.local";
        const tailnetDns = instance === "Tailnet Gateway" ? "studio.tailnet.ts.net" : "";
        const displayName =
          instance === studioInstance
            ? "Peter\\226\\128\\153s\\032Mac\\032Studio"
            : instance.replace(" Gateway", "");
        return commandResult(
          `${instance}._openclaw-gw._tcp. can be reached at ${host}:18789\ntxtvers=1 displayName=${displayName} lanHost=${host} gatewayPort=18789 sshPort=22${tailnetDns ? ` tailnetDns=${tailnetDns}` : ""}\n`,
        );
      }

      throw new Error(`unexpected argv: ${argv.join(" ")}`);
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

    const browseCalls = calls.filter((c) => c.argv[0] === "dns-sd" && c.argv[1] === "-B");
    expect(browseCalls.map((c) => c.argv[3])).toEqual(
      expect.arrayContaining(["local.", WIDE_AREA_DOMAIN]),
    );
    expect([...new Set(browseCalls.map((c) => c.timeoutMs))]).toEqual([1234]);
  });

  it("shares the caller deadline across DNS-SD resolutions and fallback discovery", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const budgets: number[] = [];
    const run = vi
      .spyOn(processExec, "runCommandWithTimeout")
      .mockImplementation(async (argv, options) => {
        const timeoutMs = typeof options === "number" ? options : options.timeoutMs;
        if (argv[1] === "-B") {
          if (argv[3] !== "local.") {
            return commandResult("");
          }
          now = 100;
          return commandResult(
            ["First", "Second", "Third"]
              .map((name) => `Add 2 3 local. _openclaw-gw._tcp. ${name}`)
              .join("\n"),
          );
        }
        if (argv[1] === "-L") {
          budgets.push(timeoutMs ?? 0);
          now += 200;
          return commandResult(`${argv[2]} can be reached at gateway.local:18789`);
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
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (argv) => {
        const domain = argv[3] ?? "";
        const txt =
          "txtvers=1 displayName=Broken gatewayPort=70000 sshPort=22x gatewayTls=yes gatewayTlsSha256=synthetic role=gateway transport=gateway";
        if (argv[0] === "avahi-browse") {
          return commandResult(
            `= eth0 IPv4 Broken Gateway _openclaw-gw._tcp local.\n hostname = [broken.local]\n port = [70000]\n txt = [${txt
              .split(" ")
              .map((token) => `"${token}"`)
              .join(" ")}]`,
          );
        }
        if (argv[0] === "dns-sd" && argv[1] === "-B" && domain === "local.") {
          return commandResult("Add 2 3 local. _openclaw-gw._tcp. Broken Gateway\n");
        }

        if (argv[0] === "dns-sd" && argv[1] === "-L") {
          return commandResult(
            `Broken Gateway._openclaw-gw._tcp. can be reached at broken.local:18789abc\n${txt}\n`,
          );
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
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const calls: Array<{ argv: string[]; timeoutMs?: number }> = [];
    const zone = WIDE_AREA_DOMAIN.replace(/\.$/, "");
    const serviceBase = `_openclaw-gw._tcp.${zone}`;
    const studioService = `studio-gateway.${serviceBase}`;

    vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      calls.push({ argv, timeoutMs: typeof options === "number" ? options : options.timeoutMs });
      const cmd = argv[0];

      if (cmd === "dns-sd" && argv[1] === "-B") {
        return commandResult("");
      }

      if (cmd === "tailscale" && argv[1] === "status" && argv[2] === "--json") {
        return commandResult(
          JSON.stringify({
            Self: { TailscaleIPs: ["100.69.232.64"] },
            Peer: { "peer-1": { TailscaleIPs: ["100.123.224.76"] } },
          }),
        );
      }

      if (cmd === "dig") {
        const at = argv.find((a) => a.startsWith("@")) ?? "";
        const server = at.replace(/^@/, "");
        const qname = argv[argv.length - 2] ?? "";
        const qtype = argv[argv.length - 1] ?? "";

        if (server === "100.123.224.76" && qtype === "PTR" && qname === serviceBase) {
          return commandResult(`${studioService}.\n`);
        }

        if (server === "100.123.224.76" && qtype === "SRV" && qname === studioService) {
          return commandResult(`0 0 18789 studio.${zone}.\n`);
        }

        if (server === "100.123.224.76" && qtype === "TXT" && qname === studioService) {
          return commandResult(
            '"displayName=Studio" "gatewayPort=18789" "transport=gateway" "sshPort=22" "tailnetDns=peters-mac-studio-1.sheep-coho.ts.net" "cliPath=/opt/homebrew/bin/openclaw" ',
          );
        }
      }

      throw new Error(`unexpected argv: ${argv.join(" ")}`);
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

    expect(calls.map((c) => c.argv.slice(0, 2).join(" "))).toContain("tailscale status");
    expect(calls.map((c) => c.argv[0])).toContain("dig");
  });
});
