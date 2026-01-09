import { describe, expect, it, vi } from "vitest";

import type { runCommandWithTimeout } from "../process/exec.js";
import { WIDE_AREA_DISCOVERY_DOMAIN } from "./widearea-dns.js";
import { discoverGatewayBeacons } from "./bonjour-discovery.js";

describe("bonjour-discovery", () => {
  it("discovers beacons on darwin across local + wide-area domains", async () => {
    const calls: Array<{ argv: string[]; timeoutMs: number }> = [];

    const run = vi.fn(async (argv: string[], options: { timeoutMs: number }) => {
      calls.push({ argv, timeoutMs: options.timeoutMs });
      const domain = argv[3] ?? "";

      if (argv[0] === "dns-sd" && argv[1] === "-B") {
        if (domain === "local.") {
          return {
            stdout: [
              "Add 2 3 local. _clawdbot-bridge._tcp. Studio Bridge",
              "Add 2 3 local. _clawdbot-bridge._tcp. Laptop Bridge",
              "",
            ].join("\n"),
            stderr: "",
            code: 0,
            signal: null,
            killed: false,
          };
        }
        if (domain === WIDE_AREA_DISCOVERY_DOMAIN) {
          return {
            stdout: [
              `Add 2 3 ${WIDE_AREA_DISCOVERY_DOMAIN} _clawdbot-bridge._tcp. Tailnet Bridge`,
              "",
            ].join("\n"),
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
          instance === "Studio Bridge"
            ? "studio.local"
            : instance === "Laptop Bridge"
              ? "laptop.local"
              : "tailnet.local";
        const tailnetDns =
          instance === "Tailnet Bridge" ? "studio.tailnet.ts.net" : "";
        const txtParts = [
          "txtvers=1",
          `displayName=${instance.replace(" Bridge", "")}`,
          `lanHost=${host}`,
          "gatewayPort=18789",
          "bridgePort=18790",
          "sshPort=22",
          tailnetDns ? `tailnetDns=${tailnetDns}` : null,
        ].filter((v): v is string => Boolean(v));

        return {
          stdout: [
            `${instance}._clawdbot-bridge._tcp. can be reached at ${host}:18790`,
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
      run: run as unknown as typeof runCommandWithTimeout,
    });

    expect(beacons).toHaveLength(3);
    expect(beacons.map((b) => b.domain)).toEqual(
      expect.arrayContaining(["local.", WIDE_AREA_DISCOVERY_DOMAIN]),
    );

    const browseCalls = calls.filter(
      (c) => c.argv[0] === "dns-sd" && c.argv[1] === "-B",
    );
    expect(browseCalls.map((c) => c.argv[3])).toEqual(
      expect.arrayContaining(["local.", WIDE_AREA_DISCOVERY_DOMAIN]),
    );
    expect(browseCalls.every((c) => c.timeoutMs === 1234)).toBe(true);
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
      domains: ["local", "clawdbot.internal"],
      run: run as unknown as typeof runCommandWithTimeout,
    });

    expect(calls.filter((c) => c[1] === "-B").map((c) => c[3])).toEqual(
      expect.arrayContaining(["local.", "clawdbot.internal."]),
    );

    calls.length = 0;
    await discoverGatewayBeacons({
      platform: "darwin",
      timeoutMs: 1,
      domains: ["local."],
      run: run as unknown as typeof runCommandWithTimeout,
    });

    expect(calls.filter((c) => c[1] === "-B")).toHaveLength(1);
    expect(calls.filter((c) => c[1] === "-B")[0]?.[3]).toBe("local.");
  });
});
