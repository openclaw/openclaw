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
});
