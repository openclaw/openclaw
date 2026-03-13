import { describe, expect, it } from "vitest";
import {
  normalizeWideAreaDomain,
  renderWideAreaGatewayZoneText,
  resolveWideAreaDiscoveryDomain,
} from "./widearea-dns.js";

describe("wide-area DNS discovery domain helpers", () => {
  it.each([
    { value: "openclaw.internal", expected: "openclaw.internal." },
    { value: "openclaw.internal.", expected: "openclaw.internal." },
    { value: "  openclaw.internal  ", expected: "openclaw.internal." },
    { value: "", expected: null },
    { value: "   ", expected: null },
    { value: null, expected: null },
    { value: undefined, expected: null },
  ])("normalizes domains for %j", ({ value, expected }) => {
    expect(normalizeWideAreaDomain(value)).toBe(expected);
  });

  it.each([
    {
      name: "prefers config domain over env",
      params: {
        env: { OPENCLAW_WIDE_AREA_DOMAIN: "env.internal" } as NodeJS.ProcessEnv,
        configDomain: "config.internal",
      },
      expected: "config.internal.",
    },
    {
      name: "falls back to env domain",
      params: {
        env: { OPENCLAW_WIDE_AREA_DOMAIN: "env.internal" } as NodeJS.ProcessEnv,
      },
      expected: "env.internal.",
    },
    {
      name: "returns null when both sources are blank",
      params: {
        env: { OPENCLAW_WIDE_AREA_DOMAIN: "   " } as NodeJS.ProcessEnv,
        configDomain: " ",
      },
      expected: null,
    },
  ])("$name", ({ params, expected }) => {
    expect(resolveWideAreaDiscoveryDomain(params)).toBe(expected);
  });
});

describe("wide-area DNS-SD zone rendering", () => {
  it("renders a zone with gateway PTR/SRV/TXT records", () => {
    const txt = renderWideAreaGatewayZoneText({
      domain: "openclaw.internal.",
      serial: 2025121701,
      gatewayPort: 18789,
      displayName: "Mac Studio (OpenClaw)",
      tailnetIPv4: "100.123.224.76",
      tailnetIPv6: "fd7a:115c:a1e0::8801:e04c",
      hostLabel: "studio-london",
      instanceLabel: "studio-london",
      sshPort: 22,
      cliPath: "/opt/homebrew/bin/openclaw",
    });

    expect(txt).toContain(`$ORIGIN openclaw.internal.`);
    expect(txt).toContain(`studio-london IN A 100.123.224.76`);
    expect(txt).toContain(`studio-london IN AAAA fd7a:115c:a1e0::8801:e04c`);
    expect(txt).toContain(`_openclaw-gw._tcp IN PTR studio-london._openclaw-gw._tcp`);
    expect(txt).toContain(`studio-london._openclaw-gw._tcp IN SRV 0 0 18789 studio-london`);
    expect(txt).toContain(`displayName=Mac Studio (OpenClaw)`);
    expect(txt).toContain(`gatewayPort=18789`);
    expect(txt).toContain(`sshPort=22`);
    expect(txt).toContain(`cliPath=/opt/homebrew/bin/openclaw`);
  });

  it("includes tailnetDns when provided", () => {
    const txt = renderWideAreaGatewayZoneText({
      domain: "openclaw.internal.",
      serial: 2025121701,
      gatewayPort: 18789,
      displayName: "Mac Studio (OpenClaw)",
      tailnetIPv4: "100.123.224.76",
      tailnetDns: "peters-mac-studio-1.sheep-coho.ts.net",
      hostLabel: "studio-london",
      instanceLabel: "studio-london",
    });

    expect(txt).toContain(`tailnetDns=peters-mac-studio-1.sheep-coho.ts.net`);
  });

  it("includes gateway TLS TXT fields and trims display metadata", () => {
    const txt = renderWideAreaGatewayZoneText({
      domain: "openclaw.internal",
      serial: 2025121701,
      gatewayPort: 18789,
      displayName: "  Mac Studio (OpenClaw)  ",
      tailnetIPv4: "100.123.224.76",
      hostLabel: " Studio London ",
      instanceLabel: " Studio London ",
      gatewayTlsEnabled: true,
      gatewayTlsFingerprintSha256: "abc123",
      tailnetDns: " tailnet.ts.net ",
      cliPath: " /opt/homebrew/bin/openclaw ",
    });

    expect(txt).toContain(`$ORIGIN openclaw.internal.`);
    expect(txt).toContain(`studio-london IN A 100.123.224.76`);
    expect(txt).toContain(`studio-london._openclaw-gw._tcp IN TXT`);
    expect(txt).toContain(`displayName=Mac Studio (OpenClaw)`);
    expect(txt).toContain(`gatewayTls=1`);
    expect(txt).toContain(`gatewayTlsSha256=abc123`);
    expect(txt).toContain(`tailnetDns=tailnet.ts.net`);
    expect(txt).toContain(`cliPath=/opt/homebrew/bin/openclaw`);
  });
});
