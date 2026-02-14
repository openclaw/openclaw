import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  approveDevicePairing,
  getPairedDevice,
  requestDevicePairing,
  rotateDeviceToken,
  verifyDeviceToken,
} from "./device-pairing.js";

describe("device pairing tokens", () => {
  test("preserves existing token scopes when rotating without scopes", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-device-pairing-"));
    const request = await requestDevicePairing(
      {
        deviceId: "device-1",
        publicKey: "public-key-1",
        role: "operator",
        scopes: ["operator.admin"],
      },
      baseDir,
    );
    await approveDevicePairing(request.request.requestId, baseDir);

    await rotateDeviceToken({
      deviceId: "device-1",
      role: "operator",
      scopes: ["operator.read"],
      baseDir,
    });
    let paired = await getPairedDevice("device-1", baseDir);
    expect(paired?.tokens?.operator?.scopes).toEqual(["operator.read"]);
    expect(paired?.scopes).toEqual(["operator.read"]);

    await rotateDeviceToken({
      deviceId: "device-1",
      role: "operator",
      baseDir,
    });
    paired = await getPairedDevice("device-1", baseDir);
    expect(paired?.tokens?.operator?.scopes).toEqual(["operator.read"]);
  });

  test("verifies token and rejects mismatches", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-device-pairing-"));
    const request = await requestDevicePairing(
      {
        deviceId: "device-1",
        publicKey: "public-key-1",
        role: "operator",
        scopes: ["operator.read"],
      },
      baseDir,
    );
    await approveDevicePairing(request.request.requestId, baseDir);
    const paired = await getPairedDevice("device-1", baseDir);
    const token = paired?.tokens?.operator?.token;
    expect(token).toBeTruthy();

    const ok = await verifyDeviceToken({
      deviceId: "device-1",
      token: token ?? "",
      role: "operator",
      scopes: ["operator.read"],
      baseDir,
    });
    expect(ok.ok).toBe(true);

    const mismatch = await verifyDeviceToken({
      deviceId: "device-1",
      token: "x".repeat((token ?? "1234").length),
      role: "operator",
      scopes: ["operator.read"],
      baseDir,
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toBe("token-mismatch");
  });
});
