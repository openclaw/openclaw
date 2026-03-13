import { describe, expect, it } from "vitest";
import { loadOrCreateDeviceIdentity } from "./device-identity.js";
import { getCoreSettingFromDb } from "./state-db/core-settings-sqlite.js";
import { useCoreSettingsTestDb } from "./state-db/test-helpers.core-settings.js";

describe("device identity state dir defaults", () => {
  useCoreSettingsTestDb();

  it("stores identity in core_settings(scope='device')", () => {
    const identity = loadOrCreateDeviceIdentity();
    expect(identity.deviceId).toBeTruthy();
    expect(identity.publicKeyPem).toContain("BEGIN PUBLIC KEY");
    expect(identity.privateKeyPem).toContain("BEGIN PRIVATE KEY");

    const stored = getCoreSettingFromDb<{ deviceId: string }>("device");
    expect(stored?.deviceId).toBe(identity.deviceId);
  });

  it("returns the same identity on subsequent calls", () => {
    const first = loadOrCreateDeviceIdentity();
    const second = loadOrCreateDeviceIdentity();
    expect(second.deviceId).toBe(first.deviceId);
    expect(second.publicKeyPem).toBe(first.publicKeyPem);
  });

  it("reuses the stored identity on subsequent loads", async () => {
    await withStateDirEnv("openclaw-identity-state-", async ({ stateDir }) => {
      const first = loadOrCreateDeviceIdentity();
      const second = loadOrCreateDeviceIdentity();
      const identityPath = path.join(stateDir, "identity", "device.json");
      const raw = JSON.parse(await fs.readFile(identityPath, "utf8")) as {
        deviceId?: string;
        publicKeyPem?: string;
      };

      expect(second).toEqual(first);
      expect(raw.deviceId).toBe(first.deviceId);
      expect(raw.publicKeyPem).toBe(first.publicKeyPem);
    });
  });

  it("repairs stored device IDs that no longer match the public key", async () => {
    await withStateDirEnv("openclaw-identity-state-", async ({ stateDir }) => {
      const original = loadOrCreateDeviceIdentity();
      const identityPath = path.join(stateDir, "identity", "device.json");
      const raw = JSON.parse(await fs.readFile(identityPath, "utf8")) as Record<string, unknown>;

      await fs.writeFile(
        identityPath,
        `${JSON.stringify({ ...raw, deviceId: "stale-device-id" }, null, 2)}\n`,
        "utf8",
      );

      const repaired = loadOrCreateDeviceIdentity();
      const stored = JSON.parse(await fs.readFile(identityPath, "utf8")) as { deviceId?: string };

      expect(repaired.deviceId).toBe(original.deviceId);
      expect(stored.deviceId).toBe(original.deviceId);
    });
  });
});
