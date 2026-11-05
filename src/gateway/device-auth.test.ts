/**
 * Gateway device-auth regression tests.
 */
import { describe, expect, it } from "vitest";
import {
  buildDeviceAuthPayload,
  buildDeviceAuthPayloadV3,
  buildDeviceAuthPayloadV4,
  normalizeDeviceMetadataForAuth,
} from "../../packages/gateway-client/src/device-auth.js";

const device = {
  deviceId: "dev-1",
  clientId: "openclaw-macos",
  clientMode: "ui",
  role: "operator",
  scopes: ["operator.admin", "operator.read"],
  signedAtMs: 1_700_000_000_000,
  nonce: "nonce-abc",
};

describe("device-auth payload vectors", () => {
  it.each([
    {
      name: "builds canonical v2 payloads",
      build: () =>
        buildDeviceAuthPayload({
          ...device,
          token: null,
        }),
      expected:
        "v2|dev-1|openclaw-macos|ui|operator|operator.admin,operator.read|1700000000000||nonce-abc",
    },
    {
      name: "builds canonical v3 payloads",
      build: () =>
        buildDeviceAuthPayloadV3({
          ...device,
          token: "tok-123",
          platform: "  IOS  ",
          deviceFamily: "  iPhone  ",
        }),
      expected:
        "v3|dev-1|openclaw-macos|ui|operator|operator.admin,operator.read|1700000000000|tok-123|nonce-abc|ios|iphone",
    },
    {
      name: "keeps empty metadata slots in v3 payloads",
      build: () =>
        buildDeviceAuthPayloadV3({
          deviceId: "dev-2",
          clientId: "openclaw-ios",
          clientMode: "ui",
          role: "operator",
          scopes: ["operator.read"],
          signedAtMs: 1_700_000_000_001,
          nonce: "nonce-def",
        }),
      expected: "v3|dev-2|openclaw-ios|ui|operator|operator.read|1700000000001||nonce-def||",
    },
    {
      name: "builds the canonical v4 personal bind JSON bytes",
      build: () =>
        buildDeviceAuthPayloadV4({
          ...device,
          platform: "  IOS  ",
          deviceFamily: "  iPhone  ",
          personalIdentity: {
            mode: "personal-identity",
            provider: "tailscale",
            phase: "bind",
            bindingId: "binding-1",
            issuedAtMs: 1_700_000_000_000,
          },
        }),
      expected:
        '["openclaw-device-auth","v4","dev-1","openclaw-macos","ui","operator",["operator.admin","operator.read"],"1700000000000","","nonce-abc","ios","iphone",["personal-identity","tailscale","bind","binding-1","1700000000000"]]',
    },
    {
      name: "builds the canonical v4 personal use JSON bytes",
      build: () =>
        buildDeviceAuthPayloadV4({
          ...device,
          token: "tok-123",
          platform: "  IOS  ",
          deviceFamily: "  iPhone  ",
          personalIdentity: {
            mode: "personal-identity",
            provider: "tailscale",
            phase: "use",
            bindingId: "binding-1",
            profileId: "profile-1",
            gatewayId: "boot-1",
            issuedAtMs: 1_700_000_000_000,
          },
        }),
      expected:
        '["openclaw-device-auth","v4","dev-1","openclaw-macos","ui","operator",["operator.admin","operator.read"],"1700000000000","tok-123","nonce-abc","ios","iphone",["personal-identity","tailscale","use","binding-1","profile-1","boot-1","1700000000000"]]',
    },
  ])("$name", ({ build, expected }) => {
    expect(build()).toBe(expected);
  });

  it("preserves non-ASCII metadata while normalizing ASCII case", () => {
    expect(normalizeDeviceMetadataForAuth("  İOS  ")).toBe("İos");
  });
});
