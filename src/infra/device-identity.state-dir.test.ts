import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeOpenClawStateKvJson } from "../state/openclaw-state-kv.js";
import {
  restoreStateDirEnv,
  setStateDirEnv,
  snapshotStateDirEnv,
  withStateDirEnv,
} from "../test-helpers/state-dir-env.js";
import {
  DeviceIdentityMigrationRequiredError,
  DeviceIdentityStorageError,
  loadDeviceIdentityIfPresent,
  loadDeviceIdentityIfPresentForEnv,
  loadOrCreateDeviceIdentity,
  writeStoredDeviceIdentitySnapshot,
} from "./device-identity.js";

describe("device identity state dir defaults", () => {
  it("stores the default identity under OPENCLAW_STATE_DIR", async () => {
    await withStateDirEnv("openclaw-identity-state-", async ({ stateDir }) => {
      const identity = loadOrCreateDeviceIdentity();
      const identityPath = path.join(stateDir, "identity", "device.json");
      expect(loadDeviceIdentityIfPresent(identityPath)?.deviceId).toBe(identity.deviceId);
      expect(loadDeviceIdentityIfPresentForEnv(process.env)?.deviceId).toBe(identity.deviceId);
    });
  });

  it("reuses the stored identity on subsequent loads", async () => {
    await withStateDirEnv("openclaw-identity-state-", async ({ stateDir }) => {
      const first = loadOrCreateDeviceIdentity();
      const second = loadOrCreateDeviceIdentity();
      const identityPath = path.join(stateDir, "identity", "device.json");

      expect(second).toEqual(first);
      expect(loadDeviceIdentityIfPresent(identityPath)).toEqual(first);
    });
  });

  it("repairs stored device IDs that no longer match the public key", async () => {
    await withStateDirEnv("openclaw-identity-state-", async ({ stateDir }) => {
      const original = loadOrCreateDeviceIdentity();
      const identityPath = path.join(stateDir, "identity", "device.json");
      const raw = {
        version: 1,
        deviceId: original.deviceId,
        publicKeyPem: original.publicKeyPem,
        privateKeyPem: original.privateKeyPem,
        createdAtMs: Date.now(),
      };

      writeStoredDeviceIdentitySnapshot(identityPath, { ...raw, deviceId: "stale-device-id" });

      const repaired = loadOrCreateDeviceIdentity();

      expect(repaired.deviceId).toBe(original.deviceId);
      expect(loadDeviceIdentityIfPresent(identityPath)?.deviceId).toBe(original.deviceId);
    });
  });

  it("fails closed when a legacy identity file exists before doctor import", async () => {
    await withStateDirEnv("openclaw-identity-state-", async ({ stateDir }) => {
      const original = loadOrCreateDeviceIdentity(path.join(stateDir, "seed-device.json"));
      const identityPath = path.join(stateDir, "identity", "device.json");
      const legacy = {
        version: 1,
        deviceId: original.deviceId,
        publicKeyPem: original.publicKeyPem,
        privateKeyPem: original.privateKeyPem,
        createdAtMs: Date.now(),
      };

      await fs.mkdir(path.dirname(identityPath), { recursive: true });
      await fs.writeFile(identityPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

      await expect(() => loadOrCreateDeviceIdentity()).toThrow(
        DeviceIdentityMigrationRequiredError,
      );
      await expect(() => loadOrCreateDeviceIdentity()).toThrow(/openclaw doctor --fix/u);
    });
  });

  it("fails closed when the legacy identity file is invalid", async () => {
    await withStateDirEnv("openclaw-identity-state-", async ({ stateDir }) => {
      const identityPath = path.join(stateDir, "identity", "device.json");
      await fs.mkdir(path.dirname(identityPath), { recursive: true });
      await fs.writeFile(identityPath, '{"version":1,"deviceId":"broken"}\n', "utf8");

      await expect(() => loadOrCreateDeviceIdentity()).toThrow(
        DeviceIdentityMigrationRequiredError,
      );
    });
  });

  it("fails closed when the SQLite identity row is invalid", async () => {
    await withStateDirEnv("openclaw-identity-state-", async () => {
      writeOpenClawStateKvJson("identity.device", "default", {
        version: 1,
        deviceId: "broken",
      });

      await expect(() => loadOrCreateDeviceIdentity()).toThrow(DeviceIdentityStorageError);
    });
  });

  it("fails closed when the SQLite identity store cannot be opened", async () => {
    const snapshot = snapshotStateDirEnv();
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-identity-state-file-"));
    const blockedStateDir = path.join(tempRoot, "state");
    try {
      await fs.writeFile(blockedStateDir, "not a directory", "utf8");
      setStateDirEnv(blockedStateDir);

      expect(() => loadOrCreateDeviceIdentity()).toThrow();
    } finally {
      restoreStateDirEnv(snapshot);
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
