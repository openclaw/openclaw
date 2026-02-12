import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  approveDevicePairing,
  getPairedDevice,
  requestDevicePairing,
  rotateDeviceToken,
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
});

describe("addPairedDevice", () => {
  test("directly adds a new device as paired", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-add-paired-"));
    const { addPairedDevice } = await import("./device-pairing.js");

    const result = await addPairedDevice(
      {
        deviceId: "direct-device-1",
        publicKey: "direct-pub-key-1",
        displayName: "CLI (test)",
        platform: "linux",
        role: "operator",
        roles: ["operator"],
        scopes: ["operator.admin", "operator.approvals", "operator.pairing"],
      },
      baseDir,
    );

    expect(result.created).toBe(true);
    expect(result.device.deviceId).toBe("direct-device-1");
    expect(result.device.publicKey).toBe("direct-pub-key-1");
    expect(result.device.role).toBe("operator");
    expect(result.device.roles).toContain("operator");
    expect(result.device.scopes).toEqual(
      expect.arrayContaining(["operator.admin", "operator.approvals", "operator.pairing"]),
    );
    expect(result.device.tokens).toEqual({});
    expect(result.device.createdAtMs).toBeGreaterThan(0);
    expect(result.device.approvedAtMs).toBeGreaterThan(0);

    // Verify retrievable via getPairedDevice
    const paired = await getPairedDevice("direct-device-1", baseDir);
    expect(paired).not.toBeNull();
    expect(paired?.deviceId).toBe("direct-device-1");
  });

  test("returns existing device without overwriting when already paired", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-add-paired-idempotent-"));
    const { addPairedDevice } = await import("./device-pairing.js");

    const first = await addPairedDevice(
      {
        deviceId: "dup-device",
        publicKey: "pub-key-dup",
        displayName: "First",
        role: "operator",
        roles: ["operator"],
        scopes: ["operator.admin"],
      },
      baseDir,
    );
    expect(first.created).toBe(true);

    const second = await addPairedDevice(
      {
        deviceId: "dup-device",
        publicKey: "pub-key-dup-v2",
        displayName: "Second",
        role: "operator",
        roles: ["operator"],
        scopes: ["operator.admin", "operator.extra"],
      },
      baseDir,
    );
    expect(second.created).toBe(false);
    // Should still be the original data
    expect(second.device.displayName).toBe("First");
    expect(second.device.publicKey).toBe("pub-key-dup");
  });

  test("throws when deviceId is empty", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-add-paired-err-"));
    const { addPairedDevice } = await import("./device-pairing.js");

    await expect(addPairedDevice({ deviceId: "", publicKey: "key" }, baseDir)).rejects.toThrow(
      "deviceId required",
    );

    await expect(addPairedDevice({ deviceId: "  ", publicKey: "key" }, baseDir)).rejects.toThrow(
      "deviceId required",
    );
  });
});
