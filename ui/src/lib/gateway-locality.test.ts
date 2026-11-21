import { expect, it } from "vitest";
import { isLocalPortalHostname as portal, isLoopbackHostname } from "./gateway-locality.ts";
it.each([
  ["localhost|127.0.0.5|[::1]", true, true],
  ["openclaw.localhost|a.b.localhost|OPENCLAW.LOCALHOST|  openclaw.localhost  ", false, true],
  ["127.0.0.1.evil.com|localhost.evil.com|evil-localhost|example.com", false, false],
])("classifies %s", (hosts, retry, delivery) => {
  for (const host of hosts.split("|")) {
    expect([isLoopbackHostname(host), portal(host)]).toEqual([retry, delivery]);
  }
});
