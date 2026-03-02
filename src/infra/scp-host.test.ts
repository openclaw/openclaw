import { describe, expect, it } from "vitest";
import { isSafeScpRemoteHost, normalizeScpRemoteHost } from "./scp-host.js";

describe("scp remote host", () => {
  it("accepts host and user@host forms", () => {
    expect(normalizeScpRemoteHost("gateway-host")).toBe("gateway-host");
    expect(normalizeScpRemoteHost("bot@gateway-host")).toBe("bot@gateway-host");
    expect(normalizeScpRemoteHost("bot@192.168.64.3")).toBe("bot@192.168.64.3");
    expect(normalizeScpRemoteHost("bot@[fe80::1]")).toBe("bot@[fe80::1]");
  });

  it("rejects unsafe host tokens", () => {
    expect(isSafeScpRemoteHost("-oProxyCommand=whoami")).toBe(false);
    expect(isSafeScpRemoteHost("bot@gateway-host -oStrictHostKeyChecking=no")).toBe(false);
    expect(isSafeScpRemoteHost("bot@host:22")).toBe(false);
    expect(isSafeScpRemoteHost("bot@/tmp/host")).toBe(false);
    expect(isSafeScpRemoteHost("bot@@host")).toBe(false);
  });
});
