import { describe, expect, it } from "vitest";
import {
  buildDeviceAuthPayload,
  buildDeviceAuthPayloadV3,
  buildDeviceAuthPayloadV4,
  normalizeDeviceMetadataForAuth,
} from "./device-auth.js";

describe("device-auth payload vectors", () => {
  it.each([
    {
      name: "builds canonical v2 payloads",
      build: () =>
        buildDeviceAuthPayload({
          deviceId: "dev-1",
          clientId: "openclaw-macos",
          clientMode: "ui",
          role: "operator",
          scopes: ["operator.admin", "operator.read"],
          signedAtMs: 1_700_000_000_000,
          token: null,
          nonce: "nonce-abc",
        }),
      expected:
        "v2|dev-1|openclaw-macos|ui|operator|operator.admin,operator.read|1700000000000||nonce-abc",
    },
    {
      name: "builds canonical v3 payloads",
      build: () =>
        buildDeviceAuthPayloadV3({
          deviceId: "dev-1",
          clientId: "openclaw-macos",
          clientMode: "ui",
          role: "operator",
          scopes: ["operator.admin", "operator.read"],
          signedAtMs: 1_700_000_000_000,
          token: "tok-123",
          nonce: "nonce-abc",
          platform: "  IOS  ",
          deviceFamily: "  iPhone  ",
        }),
      expected:
        "v3|dev-1|openclaw-macos|ui|operator|operator.admin,operator.read|1700000000000|tok-123|nonce-abc|ios|iphone",
    },
    {
      name: "builds canonical v4 payloads",
      build: () =>
        buildDeviceAuthPayloadV4({
          deviceId: "dev-1",
          clientId: "node-host",
          clientMode: "node",
          role: "node",
          scopes: [],
          signedAtMs: 1_700_000_000_002,
          token: "tok-456",
          nonce: "nonce-ghi",
          platform: "  macOS  ",
          deviceFamily: "  Mac  ",
          instanceId: " custom-node-id ",
        }),
      expected:
        "v4|dev-1|node-host|node|node||1700000000002|tok-456|nonce-ghi|macos|mac|custom-node-id",
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
  ])("$name", ({ build, expected }) => {
    expect(build()).toBe(expected);
  });

  it.each([
    { input: "  İOS  ", expected: "İos" },
    { input: "  MAC  ", expected: "mac" },
    { input: undefined, expected: "" },
  ])("normalizes metadata %j", ({ input, expected }) => {
    expect(normalizeDeviceMetadataForAuth(input)).toBe(expected);
  });
});
