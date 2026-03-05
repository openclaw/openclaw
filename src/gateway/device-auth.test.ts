import { describe, expect, it } from "vitest";
import { buildDeviceAuthPayloadV3, normalizeDeviceMetadataForAuth } from "./device-auth.js";

describe("device-auth payload vectors", () => {
  it("builds canonical v3 payload", () => {
    const payload = buildDeviceAuthPayloadV3({
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
    });

    expect(payload).toBe(
      "v3|dev-1|openclaw-macos|ui|operator|operator.admin,operator.read|1700000000000|tok-123|nonce-abc|ios|iphone",
    );
  });

  it("normalizes metadata with ASCII-only lowercase", () => {
    expect(normalizeDeviceMetadataForAuth("  İOS  ")).toBe("İos");
    expect(normalizeDeviceMetadataForAuth("  MAC  ")).toBe("mac");
    expect(normalizeDeviceMetadataForAuth(undefined)).toBe("");
  });
});
