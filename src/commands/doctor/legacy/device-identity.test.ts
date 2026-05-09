import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrCreateDeviceIdentity } from "../../../infra/device-identity.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import { withStateDirEnv } from "../../../test-helpers/state-dir-env.js";
import {
  importLegacyDeviceIdentityFileToSqlite,
  legacyDeviceIdentityFileExists,
} from "./device-identity.js";

function storedIdentityFrom(identity: ReturnType<typeof loadOrCreateDeviceIdentity>) {
  return {
    version: 1 as const,
    deviceId: identity.deviceId,
    publicKeyPem: identity.publicKeyPem,
    privateKeyPem: identity.privateKeyPem,
    createdAtMs: Date.now(),
  };
}

describe("legacy device identity migration", () => {
  it("imports legacy identity/device.json into SQLite and removes the source", async () => {
    await withStateDirEnv("openclaw-doctor-device-identity-", async ({ stateDir }) => {
      const original = loadOrCreateDeviceIdentity(path.join(stateDir, "seed-device.json"));
      const identityPath = path.join(stateDir, "identity", "device.json");
      await fs.mkdir(path.dirname(identityPath), { recursive: true });
      await fs.writeFile(
        identityPath,
        `${JSON.stringify(storedIdentityFrom(original), null, 2)}\n`,
        "utf8",
      );

      expect(legacyDeviceIdentityFileExists()).toBe(true);
      expect(importLegacyDeviceIdentityFileToSqlite()).toEqual({ imported: true });

      await expect(fs.stat(identityPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(loadOrCreateDeviceIdentity().deviceId).toBe(original.deviceId);
    });
    closeOpenClawStateDatabaseForTest();
  });

  it("imports a stale device id and lets runtime repair the stored row", async () => {
    await withStateDirEnv("openclaw-doctor-device-identity-", async ({ stateDir }) => {
      const original = loadOrCreateDeviceIdentity(path.join(stateDir, "seed-device.json"));
      const identityPath = path.join(stateDir, "identity", "device.json");
      await fs.mkdir(path.dirname(identityPath), { recursive: true });
      await fs.writeFile(
        identityPath,
        `${JSON.stringify({ ...storedIdentityFrom(original), deviceId: "stale-device-id" }, null, 2)}\n`,
        "utf8",
      );

      expect(importLegacyDeviceIdentityFileToSqlite()).toEqual({ imported: true });

      expect(loadOrCreateDeviceIdentity().deviceId).toBe(original.deviceId);
    });
    closeOpenClawStateDatabaseForTest();
  });

  it("leaves invalid legacy identity files for a later doctor pass", async () => {
    await withStateDirEnv("openclaw-doctor-device-identity-", async ({ stateDir }) => {
      const identityPath = path.join(stateDir, "identity", "device.json");
      await fs.mkdir(path.dirname(identityPath), { recursive: true });
      await fs.writeFile(identityPath, '{"version":1,"deviceId":"broken"}\n', "utf8");

      expect(importLegacyDeviceIdentityFileToSqlite()).toEqual({ imported: false });
      expect(legacyDeviceIdentityFileExists()).toBe(true);
    });
    closeOpenClawStateDatabaseForTest();
  });

  it("skips when no legacy identity file exists", async () => {
    await withStateDirEnv("openclaw-doctor-device-identity-", async () => {
      expect(importLegacyDeviceIdentityFileToSqlite()).toEqual({ imported: false });
      expect(legacyDeviceIdentityFileExists()).toBe(false);
    });
    closeOpenClawStateDatabaseForTest();
  });
});
