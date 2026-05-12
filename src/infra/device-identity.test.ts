import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  DeviceIdentityMigrationRequiredError,
  deriveDeviceIdFromPublicKey,
  loadDeviceIdentityIfPresent,
  loadOrCreateDeviceIdentity,
  normalizeDevicePublicKeyBase64Url,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
  verifyDeviceSignature,
  writeStoredDeviceIdentitySnapshot,
} from "./device-identity.js";

async function withIdentity(
  run: (identity: ReturnType<typeof loadOrCreateDeviceIdentity>) => void,
) {
  await withTempDir("openclaw-device-identity-", async (dir) => {
    const identity = loadOrCreateDeviceIdentity({
      env: { ...process.env, OPENCLAW_STATE_DIR: dir },
      key: "crypto-helper",
    });
    run(identity);
  });
}

describe("device identity crypto helpers", () => {
  it("fails closed for legacy identities even when the state env is injected", async () => {
    await withTempDir("openclaw-device-identity-legacy-env-", async (dir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
      const original = loadOrCreateDeviceIdentity({
        env,
        key: "seed",
      });
      const legacyPath = path.join(dir, "identity", "device.json");
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      await fs.writeFile(
        legacyPath,
        `${JSON.stringify(
          {
            version: 1,
            deviceId: original.deviceId,
            publicKeyPem: original.publicKeyPem,
            privateKeyPem: original.privateKeyPem,
            createdAtMs: Date.now(),
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      expect(() => loadOrCreateDeviceIdentity({ env })).toThrow(
        DeviceIdentityMigrationRequiredError,
      );
    });
  });

  it("loads an existing identity from SQLite", async () => {
    await withTempDir("openclaw-device-identity-readonly-", async (dir) => {
      const store = { env: { ...process.env, OPENCLAW_STATE_DIR: dir }, key: "readonly" };

      expect(loadDeviceIdentityIfPresent(store)).toBeNull();

      const created = loadOrCreateDeviceIdentity(store);

      expect(loadDeviceIdentityIfPresent(store)).toEqual(created);
    });
  });

  it("stores generated key material as normalized PEM blocks", async () => {
    await withIdentity((identity) => {
      expect(identity.publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----\n")).toBe(true);
      expect(identity.publicKeyPem.endsWith("-----END PUBLIC KEY-----\n")).toBe(true);
      expect(identity.privateKeyPem.startsWith("-----BEGIN PRIVATE KEY-----\n")).toBe(true);
      expect(identity.privateKeyPem.endsWith("-----END PRIVATE KEY-----\n")).toBe(true);
    });
  });

  it("does not repair mismatched stored device ids in read-only mode", async () => {
    await withTempDir("openclaw-device-identity-readonly-", async (dir) => {
      const store = { env: { ...process.env, OPENCLAW_STATE_DIR: dir }, key: "mismatched" };
      const created = loadOrCreateDeviceIdentity(store);
      const stored = {
        version: 1,
        deviceId: created.deviceId,
        publicKeyPem: created.publicKeyPem,
        privateKeyPem: created.privateKeyPem,
        createdAtMs: Date.now(),
      } as const;
      writeStoredDeviceIdentitySnapshot({ ...stored, deviceId: "mismatched" }, store);

      expect(loadDeviceIdentityIfPresent(store)).toBeNull();
    });
  });

  it("derives the same canonical raw key and device id from pem and encoded public keys", async () => {
    await withIdentity((identity) => {
      const publicKeyRaw = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
      const paddedBase64 = `${publicKeyRaw.replaceAll("-", "+").replaceAll("_", "/")}==`;

      expect(normalizeDevicePublicKeyBase64Url(identity.publicKeyPem)).toBe(publicKeyRaw);
      expect(normalizeDevicePublicKeyBase64Url(paddedBase64)).toBe(publicKeyRaw);
      expect(deriveDeviceIdFromPublicKey(identity.publicKeyPem)).toBe(identity.deviceId);
      expect(deriveDeviceIdFromPublicKey(publicKeyRaw)).toBe(identity.deviceId);
    });
  });

  it("signs payloads that verify against pem and raw public key forms", async () => {
    await withIdentity((identity) => {
      const payload = JSON.stringify({
        action: "system.run",
        ts: 1234,
      });
      const signature = signDevicePayload(identity.privateKeyPem, payload);
      const publicKeyRaw = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);

      expect(verifyDeviceSignature(identity.publicKeyPem, payload, signature)).toBe(true);
      expect(verifyDeviceSignature(publicKeyRaw, payload, signature)).toBe(true);
      expect(verifyDeviceSignature(publicKeyRaw, `${payload}!`, signature)).toBe(false);
    });
  });

  it("fails closed for invalid public keys and signatures", async () => {
    await withIdentity((identity) => {
      const payload = "hello";
      const signature = signDevicePayload(identity.privateKeyPem, payload);

      expect(normalizeDevicePublicKeyBase64Url("-----BEGIN PUBLIC KEY-----broken")).toBeNull();
      expect(deriveDeviceIdFromPublicKey("%%%")).toBeNull();
      expect(verifyDeviceSignature("%%%invalid%%%", payload, signature)).toBe(false);
      expect(verifyDeviceSignature(identity.publicKeyPem, payload, "%%%invalid%%%")).toBe(false);
    });
  });
});
