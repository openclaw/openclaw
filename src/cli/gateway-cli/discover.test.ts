import { expect, it } from "vitest";
import { stripAnsi } from "../../../packages/terminal-core/src/ansi.js";
import type { GatewayBonjourBeacon } from "../../infra/bonjour-discovery.js";
import {
  buildGatewayDiscoveryLabel,
  buildGatewayDiscoveryTarget,
  serializeGatewayDiscoveryBeacon,
} from "../../infra/gateway-discovery-targets.js";
import { dedupeBeacons, renderBeaconLines } from "./discover.js";

it.each([
  ["2001:db8::10", "[2001:db8::10]"],
  ["[2001:db8::10]", "[2001:db8::10]"],
  ["192.0.2.10", "192.0.2.10"],
  ["gateway.local", "gateway.local"],
])("serializes discovery authorities for %s", (host, authority) => {
  const beacon = { instanceName: "Gateway", host, port: 18789, sshPort: 2222 };
  for (const gatewayTls of [false, true]) {
    const input = { ...beacon, gatewayTls };
    const wsUrl = `${gatewayTls ? "wss" : "ws"}://${authority}:18789`;
    expect(buildGatewayDiscoveryTarget(input, { sshUser: "me" })).toMatchObject({
      wsUrl,
      sshTarget: `me@${authority}:2222`,
    });
    expect(serializeGatewayDiscoveryBeacon(input).wsUrl).toBe(wsUrl);
    expect(buildGatewayDiscoveryLabel(input)).toBe(`Gateway (${authority}:18789)`);
    expect(renderBeaconLines(input, false)).toContain(`  ws: ${wsUrl}`);
    expect(renderBeaconLines(input, false)).toContain(
      `  ssh: ssh -N -L 18789:127.0.0.1:18789 <user>@${host.replace(/^\[|\]$/g, "")} -p 2222`,
    );
    expect(new URL(wsUrl).port).toBe("18789");
  }
});

it.each([false, true])(
  "escapes terminal controls in all discovery report fields (rich=%s)",
  (rich) => {
    const text = "café\u001b[31m\nforged\tend\rrow\u0007";
    const beacon: GatewayBonjourBeacon = {
      instanceName: "fixture",
      displayName: text,
      domain: text,
      host: text,
      lanHost: text,
      tailnetDns: text,
      port: 18789,
      gatewayPort: 18789,
      sshPort: 22,
      role: text,
      transport: text,
      gatewayTls: true,
      gatewayTlsFingerprintSha256: text,
    };
    const before = structuredClone(beacon);
    const lines = renderBeaconLines(beacon, rich).map(stripAnsi);
    expect(lines).toHaveLength(9);
    for (const line of lines) {
      expect(line).not.toMatch(/\p{Cc}/u);
      expect(line).toContain("café\\nforged\\tend\\rrow");
    }
    expect(beacon).toEqual(before);
    expect(
      renderBeaconLines(
        {
          instanceName: "ordinary",
          displayName: "Ordinary Gateway",
          domain: "local.",
          host: "host.local",
          port: 18789,
        },
        false,
      ),
    ).toEqual(["- Ordinary Gateway local.", "  host: host.local", "  ws: ws://host.local:18789"]);
  },
);

it("retains the first beacon per display and resolved endpoint key without merging distinct keys", () => {
  const first: GatewayBonjourBeacon = {
    instanceName: "gateway",
    domain: "local.",
    displayName: "Gateway",
    host: " host.local ",
    port: 18789,
    gatewayPort: 18789,
    sshPort: 22,
  };
  const duplicate = { ...first, host: "host.local", sshPort: 2222 };
  const variants = [
    { ...first, domain: "other." },
    { ...first, instanceName: "other" },
    { ...first, displayName: "Other" },
    { ...first, host: "other.local" },
    { ...first, port: 18790 },
    { ...first, gatewayPort: 18790 },
  ];
  const result = dedupeBeacons([first, duplicate, ...variants]);
  expect(result).toEqual([first, ...variants]);
  expect(result[0]).toBe(first);
});
