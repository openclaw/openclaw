import { expect, it } from "vitest";
import { stripAnsi } from "../../../packages/terminal-core/src/ansi.js";
import type { GatewayBonjourBeacon } from "../../infra/bonjour-discovery.js";
import { dedupeBeacons, renderBeaconLines } from "./discover.js";

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
