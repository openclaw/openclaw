import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
  verifyDeviceSignature,
} from "../../../infra/device-identity.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import { withStateDirEnv } from "../../../test-helpers/state-dir-env.js";
import {
  importLegacyDeviceIdentityFileToSqlite,
  legacyDeviceIdentityFileExists,
} from "./device-identity.js";

const SWIFT_RAW_DEVICE_ID = "56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c";
const SWIFT_RAW_PUBLIC_KEY = "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=";
const SWIFT_RAW_PRIVATE_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="; // pragma: allowlist secret
const MISMATCHED_SWIFT_RAW_PRIVATE_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="; // pragma: allowlist secret

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

  it("imports Swift raw-key identity files into SQLite", async () => {
    await withStateDirEnv("openclaw-doctor-device-identity-", async ({ stateDir }) => {
      const identityPath = path.join(stateDir, "identity", "device.json");
      await fs.mkdir(path.dirname(identityPath), { recursive: true });
      await fs.writeFile(
        identityPath,
        `${JSON.stringify(
          {
            deviceId: SWIFT_RAW_DEVICE_ID,
            publicKey: SWIFT_RAW_PUBLIC_KEY,
            privateKey: SWIFT_RAW_PRIVATE_KEY,
            createdAtMs: 1_700_000_000_000,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      expect(importLegacyDeviceIdentityFileToSqlite()).toEqual({ imported: true });

      const loaded = loadOrCreateDeviceIdentity();
      expect(loaded.deviceId).toBe(SWIFT_RAW_DEVICE_ID);
      expect(publicKeyRawBase64UrlFromPem(loaded.publicKeyPem)).toBe(
        "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg",
      );
      expect(
        verifyDeviceSignature(
          loaded.publicKeyPem,
          "hello",
          signDevicePayload(loaded.privateKeyPem, "hello"),
        ),
      ).toBe(true);
      await expect(fs.stat(identityPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
    closeOpenClawStateDatabaseForTest();
  });

  it("leaves Swift raw-key identity files with mismatched key material", async () => {
    await withStateDirEnv("openclaw-doctor-device-identity-", async ({ stateDir }) => {
      const identityPath = path.join(stateDir, "identity", "device.json");
      await fs.mkdir(path.dirname(identityPath), { recursive: true });
      await fs.writeFile(
        identityPath,
        `${JSON.stringify(
          {
            deviceId: SWIFT_RAW_DEVICE_ID,
            publicKey: SWIFT_RAW_PUBLIC_KEY,
            privateKey: MISMATCHED_SWIFT_RAW_PRIVATE_KEY,
            createdAtMs: 1_700_000_000_000,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      expect(importLegacyDeviceIdentityFileToSqlite()).toEqual({ imported: false });
      expect(legacyDeviceIdentityFileExists()).toBe(true);
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
