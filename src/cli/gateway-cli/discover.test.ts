import { expect, it } from "vitest";
import type { GatewayBonjourBeacon } from "../../infra/bonjour-discovery.js";
import { dedupeBeacons } from "./discover.js";

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
