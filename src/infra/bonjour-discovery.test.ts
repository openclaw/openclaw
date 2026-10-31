// Covers Bonjour gateway beacon parsing and endpoint resolution.
import { describe, expect, it, vi } from "vitest";
import type { runCommandWithTimeout } from "../process/exec.js";
import {
  discoverGatewayBeacons,
  type GatewayBonjourBeacon,
  resolveGatewayDiscoveryEndpoint,
} from "./bonjour-discovery.js";

const WIDE_AREA_DOMAIN = "openclaw.internal.";

function collectMatching<T, U>(
  items: readonly T[],
  predicate: (item: T) => boolean,
  map: (item: T) => U,
): U[] {
  const matches: U[] = [];
  for (const item of items) {
    if (predicate(item)) {
      matches.push(map(item));
    }
  }
  return matches;
}

function findBeaconByInstance(
  beacons: readonly GatewayBonjourBeacon[],
  instanceName: string,
): GatewayBonjourBeacon {
  const beacon = beacons.find((item) => item.instanceName === instanceName);
  if (!beacon) {
    throw new Error(`Expected beacon ${instanceName}`);
  }
  return beacon;
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
  it("discovers beacons on darwin across local + wide-area domains", async () => {
    const calls: Array<{ argv: string[]; timeoutMs: number }> = [];
    const studioInstance = "Peter’s Mac Studio Gateway";

    const run = vi.fn(async (argv: string[], options: { timeoutMs: number }) => {
      calls.push({ argv, timeoutMs: options.timeoutMs });
      const domain = argv[3] ?? "";

      if (argv[0] === "dns-sd" && argv[1] === "-B") {
        if (domain === "local.") {
          return {
            stdout: [
              "Add 2 3 local. _openclaw-gw._tcp. Peter\\226\\128\\153s Mac Studio Gateway",
              "Add 2 3 local. _openclaw-gw._tcp. Laptop Gateway",
              "",
            ].join("\n"),
            stderr: "",
            code: 0,
            signal: null,
            killed: false,
          };
        }
        if (domain === WIDE_AREA_DOMAIN) {
          return {
            stdout: [`Add 2 3 ${WIDE_AREA_DOMAIN} _openclaw-gw._tcp. Tailnet Gateway`, ""].join(
              "\n",
            ),
            stderr: "",
            code: 0,
            signal: null,
            killed: false,
          };
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
            ? "Peter’s\\032Mac\\032Studio"
            : instance.replace(" Gateway", "");
        const txtParts = [
          "txtvers=1",
          `displayName=${displayName}`,
          `lanHost=${host}`,
          "gatewayPort=18789",
          "sshPort=22",
          tailnetDns ? `tailnetDns=${tailnetDns}` : null,
        ].filter((v): v is string => Boolean(v));

        return {
          stdout: [
            `${instance}._openclaw-gw._tcp. can be reached at ${host}:18789`,
            txtParts.join(" "),
            "",
          ].join("\n"),
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
        };
      }

      throw new Error(`unexpected argv: ${argv.join(" ")}`);
    });

    const beacons = await discoverGatewayBeacons({
      platform: "darwin",
      timeoutMs: 1234,
      wideAreaDomain: WIDE_AREA_DOMAIN,
      run: run as unknown as typeof runCommandWithTimeout,
    });

    expect(beacons).toHaveLength(3);
    const studioBeacon = findBeaconByInstance(beacons, studioInstance);
    expect(studioBeacon.displayName).toBe("Peter’s Mac Studio");
    expect(beacons.map((b) => b.domain)).toContain("local.");
    expect(beacons.map((b) => b.domain)).toContain(WIDE_AREA_DOMAIN);

    const browseCalls = calls.filter((c) => c.argv[0] === "dns-sd" && c.argv[1] === "-B");
    expect(browseCalls.map((c) => c.argv[3])).toContain("local.");
    expect(browseCalls.map((c) => c.argv[3])).toContain(WIDE_AREA_DOMAIN);
    expect([...new Set(browseCalls.map((c) => c.timeoutMs))]).toEqual([1234]);
  });

  it("decodes dns-sd octal escapes in TXT displayName", async () => {
    const run = vi.fn(async (argv: string[], options: { timeoutMs: number }) => {
      if (options.timeoutMs < 0) {
        throw new Error("invalid timeout");
      }

      const domain = argv[3] ?? "";
      if (argv[0] === "dns-sd" && argv[1] === "-B" && domain === "local.") {
        return {
          stdout: ["Add 2 3 local. _openclaw-gw._tcp. Studio Gateway", ""].join("\n"),
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
        };
      }

      if (argv[0] === "dns-sd" && argv[1] === "-L") {
        return {
          stdout: [
            "Studio Gateway._openclaw-gw._tcp. can be reached at studio.local:18789",
            "txtvers=1 displayName=Peter\\226\\128\\153s\\032Mac\\032Studio lanHost=studio.local gatewayPort=18789 sshPort=22",
            "",
          ].join("\n"),
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
        };
      }

      return {
        stdout: "",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
      };
    });

    const beacons = await discoverGatewayBeacons({
      platform: "darwin",
      timeoutMs: 800,
      domains: ["local."],
      run: run as unknown as typeof runCommandWithTimeout,
    });

    const beacon = getOnlyBeacon(beacons);
    expect(beacon.domain).toBe("local.");
    expect(beacon.instanceName).toBe("Studio Gateway");
    expect(beacon.displayName).toBe("Peter’s Mac Studio");
    expect(beacon.txt?.displayName).toBe("Peter’s Mac Studio");
  });

  it("parses dns-sd -L ShowTXTRecord escapes for names and paths", async () => {
    // dns-sd -L output. ShowTXTRecord (mDNSResponder Clients/dns-sd.c) escapes
    // spaces and shell metacharacters as \<char>, prints one backslash as four,
    // and leaves UTF-8 raw. Ciao TXT has no txtvers key. \032 in the fullname
    // is DNS-name escaping, not TXT encoding.
    const instanceName = "Peter’s Mac Studio Gateway";
    const resolveStdout = [
      "DATE: ---Sat 31 Oct 2026---",
      String.raw`15:04:12.184  Peter\226\128\153s\032Mac\032Studio\032Gateway._openclaw-gw._tcp.local. can be reached at Peters-Mac-Studio.local.:18789 (interface 14)`,
      String.raw` role=gateway gatewayPort=18789 lanHost=Peters-Mac-Studio.local displayName=Peter’s\ Mac\ Studio cliPath=/Users/Peter\'s/Library/Application\ Support/openclaw\\\\bin transport=gateway sshPort=22`,
      "",
    ].join("\n");

    const run = vi.fn(async (argv: string[]) => {
      const domain = argv[3] ?? "";
      if (argv[0] === "dns-sd" && argv[1] === "-B" && domain === "local.") {
        return {
          stdout: [
            String.raw`Add 2 3 local. _openclaw-gw._tcp. Peter\226\128\153s Mac Studio Gateway`,
            "",
          ].join("\n"),
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
        };
      }
      if (argv[0] === "dns-sd" && argv[1] === "-L") {
        return {
          stdout: resolveStdout,
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
        };
      }
      throw new Error(`unexpected argv: ${argv.join(" ")}`);
    });

    const beacons = await discoverGatewayBeacons({
      platform: "darwin",
      timeoutMs: 800,
      domains: ["local."],
      run: run as unknown as typeof runCommandWithTimeout,
    });

    const beacon = getOnlyBeacon(beacons);
    expect(beacon).toMatchObject({
      instanceName,
      host: "Peters-Mac-Studio.local",
      port: 18789,
      displayName: "Peter’s Mac Studio",
      lanHost: "Peters-Mac-Studio.local",
      gatewayPort: 18789,
      sshPort: 22,
      cliPath: "/Users/Peter's/Library/Application Support/openclaw\\bin",
      role: "gateway",
      transport: "gateway",
      txt: { displayName: "Peter’s Mac Studio" },
    });
    expect(beacon.txt?.txtvers).toBeUndefined();
  });

  it("decodes a ShowTXTRecord backslash once and keeps control bytes", async () => {
    // Four backslashes are one literal "\" (ShowTXTRecord). A second decode
    // would read the leftover "\032" as a space. "\x0A" is a byte below 0x20.
    const run = vi.fn(async (argv: string[]) => {
      const domain = argv[3] ?? "";
      if (argv[0] === "dns-sd" && argv[1] === "-B" && domain === "local.") {
        return {
          stdout: ["Add 2 3 local. _openclaw-gw._tcp. Literal Gateway", ""].join("\n"),
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
        };
      }
      if (argv[0] === "dns-sd" && argv[1] === "-L") {
        return {
          stdout: [
            "Literal Gateway._openclaw-gw._tcp.local. can be reached at literal.local.:18789 (interface 14)",
            String.raw` displayName=\\\\032 role=a\x0Ab`,
            "",
          ].join("\n"),
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
        };
      }
      throw new Error(`unexpected argv: ${argv.join(" ")}`);
    });

    const beacons = await discoverGatewayBeacons({
      platform: "darwin",
      timeoutMs: 800,
      domains: ["local."],
      run: run as unknown as typeof runCommandWithTimeout,
    });

    const beacon = getOnlyBeacon(beacons);
    expect(beacon.displayName).toBe("\\032");
    expect(beacon.txt?.displayName).toBe("\\032");
    expect(beacon.role).toBe("a\nb");
  });

  it("rejects malformed and out-of-range advertised ports", async () => {
    const run = vi.fn(async (argv: string[]) => {
      const domain = argv[3] ?? "";
      if (argv[0] === "dns-sd" && argv[1] === "-B" && domain === "local.") {
        return {
          stdout: ["Add 2 3 local. _openclaw-gw._tcp. Broken Gateway", ""].join("\n"),
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
        };
      }

      if (argv[0] === "dns-sd" && argv[1] === "-L") {
        return {
          stdout: [
            "Broken Gateway._openclaw-gw._tcp. can be reached at broken.local:18789abc",
            "txtvers=1 displayName=Broken gatewayPort=70000 sshPort=22x",
            "",
          ].join("\n"),
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
        };
      }

      throw new Error(`unexpected argv: ${argv.join(" ")}`);
    });

    const beacons = await discoverGatewayBeacons({
      platform: "darwin",
      timeoutMs: 800,
      domains: ["local."],
      run: run as unknown as typeof runCommandWithTimeout,
    });

    const beacon = getOnlyBeacon(beacons);
    expect(beacon.host).toBe("broken.local");
    expect(beacon.port).toBeUndefined();
    expect(beacon.gatewayPort).toBeUndefined();
    expect(beacon.sshPort).toBeUndefined();
    expect(resolveGatewayDiscoveryEndpoint(beacon)).toBeNull();
  });

  it("falls back to tailnet DNS probing for wide-area when split DNS is not configured", async () => {
    const calls: Array<{ argv: string[]; timeoutMs: number }> = [];
    const zone = WIDE_AREA_DOMAIN.replace(/\.$/, "");
    const serviceBase = `_openclaw-gw._tcp.${zone}`;
    const studioService = `studio-gateway.${serviceBase}`;

    const run = vi.fn(async (argv: string[], options: { timeoutMs: number }) => {
      calls.push({ argv, timeoutMs: options.timeoutMs });
      const cmd = argv[0];

      if (cmd === "dns-sd" && argv[1] === "-B") {
        return {
          stdout: "",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
        };
      }

      if (cmd === "tailscale" && argv[1] === "status" && argv[2] === "--json") {
        return {
          stdout: JSON.stringify({
            Self: { TailscaleIPs: ["100.69.232.64"] },
            Peer: {
              "peer-1": { TailscaleIPs: ["100.123.224.76"] },
            },
          }),
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
        };
      }

      if (cmd === "dig") {
        const at = argv.find((a) => a.startsWith("@")) ?? "";
        const server = at.replace(/^@/, "");
        const qname = argv[argv.length - 2] ?? "";
        const qtype = argv[argv.length - 1] ?? "";

        if (server === "100.123.224.76" && qtype === "PTR" && qname === serviceBase) {
          return {
            stdout: `${studioService}.\n`,
            stderr: "",
            code: 0,
            signal: null,
            killed: false,
          };
        }

        if (server === "100.123.224.76" && qtype === "SRV" && qname === studioService) {
          return {
            stdout: `0 0 18789 studio.${zone}.\n`,
            stderr: "",
            code: 0,
            signal: null,
            killed: false,
          };
        }

        if (server === "100.123.224.76" && qtype === "TXT" && qname === studioService) {
          return {
            stdout: [
              `"displayName=Studio"`,
              `"gatewayPort=18789"`,
              `"transport=gateway"`,
              `"sshPort=22"`,
              `"tailnetDns=peters-mac-studio-1.sheep-coho.ts.net"`,
              `"cliPath=/opt/homebrew/bin/openclaw"`,
              "",
            ].join(" "),
            stderr: "",
            code: 0,
            signal: null,
            killed: false,
          };
        }
      }

      throw new Error(`unexpected argv: ${argv.join(" ")}`);
    });

    const beacons = await discoverGatewayBeacons({
      platform: "darwin",
      timeoutMs: 1200,
      domains: [WIDE_AREA_DOMAIN],
      wideAreaDomain: WIDE_AREA_DOMAIN,
      run: run as unknown as typeof runCommandWithTimeout,
    });

    const beacon = getOnlyBeacon(beacons);
    expect(beacon.domain).toBe(WIDE_AREA_DOMAIN);
    expect(beacon.instanceName).toBe("studio-gateway");
    expect(beacon.displayName).toBe("Studio");
    expect(beacon.host).toBe(`studio.${zone}`);
    expect(beacon.port).toBe(18789);
    expect(beacon.tailnetDns).toBe("peters-mac-studio-1.sheep-coho.ts.net");
    expect(beacon.gatewayPort).toBe(18789);
    expect(beacon.sshPort).toBe(22);
    expect(beacon.cliPath).toBe("/opt/homebrew/bin/openclaw");

    expect(calls.map((c) => c.argv.slice(0, 2).join(" "))).toContain("tailscale status");
    expect(calls.map((c) => c.argv[0])).toContain("dig");
  });

  it("normalizes domains and respects domains override", async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (argv: string[]) => {
      calls.push(argv);
      return {
        stdout: "",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
      };
    });

    await discoverGatewayBeacons({
      platform: "darwin",
      timeoutMs: 1,
      domains: ["local", "openclaw.internal"],
      run: run as unknown as typeof runCommandWithTimeout,
    });

    const browseDomains = collectMatching(
      calls,
      (c) => c[1] === "-B",
      (c) => c[3],
    );
    expect(browseDomains).toContain("local.");
    expect(browseDomains).toContain("openclaw.internal.");

    calls.length = 0;
    await discoverGatewayBeacons({
      platform: "darwin",
      timeoutMs: 1,
      domains: ["local."],
      run: run as unknown as typeof runCommandWithTimeout,
    });

    expect(calls.reduce((count, c) => count + (c[1] === "-B" ? 1 : 0), 0)).toBe(1);
    expect(calls.find((c) => c[1] === "-B")?.[3]).toBe("local.");
  });
});
