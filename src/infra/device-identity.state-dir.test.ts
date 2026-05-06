import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  importLegacyDeviceIdentityFileToSqlite,
  loadDeviceIdentityIfPresent,
  loadOrCreateDeviceIdentity,
} from "./device-identity.js";

describe("device identity state dir defaults", () => {
  it("stores the default identity under OPENCLAW_STATE_DIR", async () => {
    await withStateDirEnv("openclaw-identity-state-", async ({ stateDir }) => {
      const identity = loadOrCreateDeviceIdentity();
      const identityPath = path.join(stateDir, "identity", "device.json");
      expect(loadDeviceIdentityIfPresent(identityPath)?.deviceId).toBe(identity.deviceId);
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

      await fs.mkdir(path.dirname(identityPath), { recursive: true });
      await fs.writeFile(
        identityPath,
        `${JSON.stringify({ ...raw, deviceId: "stale-device-id" }, null, 2)}\n`,
        "utf8",
      );
      expect(importLegacyDeviceIdentityFileToSqlite()).toEqual({ imported: true });

      const repaired = loadOrCreateDeviceIdentity();

      expect(repaired.deviceId).toBe(original.deviceId);
      expect(loadDeviceIdentityIfPresent(identityPath)?.deviceId).toBe(original.deviceId);
    });
  });

  it("regenerates the identity when the stored file is invalid", async () => {
    await withStateDirEnv("openclaw-identity-state-", async ({ stateDir }) => {
      const identityPath = path.join(stateDir, "identity", "device.json");
      await fs.mkdir(path.dirname(identityPath), { recursive: true });
      await fs.writeFile(identityPath, '{"version":1,"deviceId":"broken"}\n', "utf8");

      const regenerated = loadOrCreateDeviceIdentity();
      const stored = loadDeviceIdentityIfPresent(identityPath);

      expect(stored).toEqual(regenerated);
    });
  });
});
