import { describe, expect, it } from "vitest";
import {
  resolveNodePairingClientIpSource,
  shouldAutoApproveNodePairingFromTrustedCidrs,
} from "./node-pairing-auto-approve.js";

const BASE_PARAMS = {
  existingPairedDevice: false,
  role: "node",
  reason: "not-paired" as const,
  scopes: [],
  hasBrowserOriginHeader: false,
  isControlUi: false,
  isWebchat: false,
  reportedClientIpSource: "direct" as const,
  reportedClientIp: "192.168.1.42",
  autoApproveCidrs: ["192.168.1.0/24"],
};

describe("resolveNodePairingClientIpSource", () => {
  it.each([
    ["direct", "192.168.1.42", false, false, false],
    ["trusted-proxy", "192.168.1.42", true, true, false],
    ["loopback-trusted-proxy", "192.168.1.42", true, true, true],
    ["none", undefined, true, true, false],
  ] as const)(
    "%s",
    (expected, reportedClientIp, hasProxyHeaders, remoteIsTrustedProxy, remoteIsLoopback) => {
      expect(
        resolveNodePairingClientIpSource({
          reportedClientIp,
          hasProxyHeaders,
          remoteIsTrustedProxy,
          remoteIsLoopback,
        }),
      ).toBe(expected);
    },
  );
});

describe("shouldAutoApproveNodePairingFromTrustedCidrs", () => {
  it("accepts first-time node pairing from a matching direct IPv4 CIDR", () => {
    expect(shouldAutoApproveNodePairingFromTrustedCidrs(BASE_PARAMS)).toBe(true);
  });

  it.each([
    { name: "no configured CIDRs", patch: { autoApproveCidrs: undefined } },
    { name: "role upgrade", patch: { reason: "role-upgrade" as const } },
    { name: "existing paired device", patch: { existingPairedDevice: true } },
    { name: "operator role", patch: { role: "operator" } },
    { name: "non-matching CIDR", patch: { reportedClientIp: "192.168.2.42" } },
    { name: "requested scopes", patch: { scopes: ["operator.read"] } },
    { name: "browser origin", patch: { hasBrowserOriginHeader: true } },
    { name: "Control UI client", patch: { isControlUi: true } },
    { name: "WebChat client", patch: { isWebchat: true } },
    {
      name: "loopback trusted proxy",
      patch: { reportedClientIpSource: "loopback-trusted-proxy" as const },
    },
    {
      name: "missing reported client IP",
      patch: { reportedClientIpSource: "none" as const, reportedClientIp: undefined },
    },
    { name: "invalid CIDR config", patch: { autoApproveCidrs: ["invalid/24"] } },
  ])("rejects $name", ({ patch }) => {
    expect(shouldAutoApproveNodePairingFromTrustedCidrs({ ...BASE_PARAMS, ...patch })).toBe(false);
  });
});
