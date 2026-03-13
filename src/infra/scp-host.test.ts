import { describe, expect, it } from "vitest";
import { isSafeScpRemoteHost, normalizeScpRemoteHost } from "./scp-host.js";

describe("scp remote host", () => {
  it.each([
    { value: "gateway-host", expected: "gateway-host" },
    { value: " bot@gateway-host ", expected: "bot@gateway-host" },
    { value: "bot@192.168.64.3", expected: "bot@192.168.64.3" },
    { value: "bot@[fe80::1]", expected: "bot@[fe80::1]" },
  ])("normalizes safe hosts for %j", ({ value, expected }) => {
    expect(normalizeScpRemoteHost(value)).toBe(expected);
  });

  it.each([
    null,
    undefined,
    "",
    "   ",
    "-oProxyCommand=whoami",
    "bot@gateway-host -oStrictHostKeyChecking=no",
    "bot@host:22",
    "bot@/tmp/host",
    "bot@@host",
    "@host",
    "bot@",
    "bot@host\\name",
    "bot@-gateway-host",
    "bot@fe80::1",
    "bot@[fe80::1%en0]",
    "bot name@gateway-host",
  ])("rejects unsafe host tokens: %j", (value) => {
    expect(normalizeScpRemoteHost(value)).toBeUndefined();
    expect(isSafeScpRemoteHost(value)).toBe(false);
  });
});
