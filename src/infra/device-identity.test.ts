import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { withClientCredentialStore } from "./client-credential-store.test-support.js";
import { normalizeLegacyDeviceIdentity } from "./device-identity-legacy.js";
import {
  generateStoredDeviceIdentity,
  repairInvalidStoredDeviceIdentity,
} from "./device-identity-store.js";
import {
  deriveDeviceIdFromPublicKey,
  loadDeviceIdentityIfPresent,
  loadOrCreateDeviceIdentity,
  normalizeDevicePublicKeyBase64Url,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
  verifyDeviceSignature,
} from "./device-identity.js";

const SWIFT_RAW_DEVICE_ID = "56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c";
const SWIFT_RAW_PUBLIC_KEY = "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=";
const SWIFT_RAW_PRIVATE_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="; // pragma: allowlist secret
const MISMATCHED_SWIFT_RAW_PRIVATE_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="; // pragma: allowlist secret

afterEach(() => vi.restoreAllMocks());

describe("local device identity owner", () => {
  it("reads missing credentials without creating shared or local state", async () => {
    await withTempDir("openclaw-identity-missing-", async (stateDir) => {
      expect(loadDeviceIdentityIfPresent({ env: { OPENCLAW_STATE_DIR: stateDir } })).toBeNull();
      expect(fs.readdirSync(stateDir)).toEqual([]);
    });
  });

  it("creates and reuses independent identities without a shared database", async () => {
    await withTempDir("openclaw-identity-local-", async (stateDir) => {
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const primary = loadOrCreateDeviceIdentity({ env });
      expect(loadOrCreateDeviceIdentity({ env })).toEqual(primary);
      const node = loadOrCreateDeviceIdentity({ env, identityKey: "node" });
      expect(node.deviceId).not.toBe(primary.deviceId);
      expect(loadDeviceIdentityIfPresent({ env, identityKey: "node" })).toEqual(node);
      expect(fs.existsSync(path.join(stateDir, "client", "credentials.sqlite"))).toBe(true);
      expect(fs.existsSync(path.join(stateDir, "state"))).toBe(false);
    });
  });

  it("fails closed on corrupt persisted identity and lets Doctor preserve matching keys", async () => {
    await withTempDir("openclaw-identity-repair-", async (stateDir) => {
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const original = loadOrCreateDeviceIdentity({ env });
      withClientCredentialStore(env, false, (db) => {
        db.prepare("UPDATE device_identities SET device_id = ? WHERE identity_key = ?").run(
          "corrupt",
          "primary",
        );
      });
      expect(() => loadDeviceIdentityIfPresent({ env })).toThrow(
        "invalid persisted device identity",
      );
      expect(() => loadOrCreateDeviceIdentity({ env })).toThrow(
        "invalid persisted device identity",
      );
      const repaired = repairInvalidStoredDeviceIdentity(generateStoredDeviceIdentity(), { env });
      expect(repaired).toMatchObject({ repaired: true, rotated: false });
      expect(loadDeviceIdentityIfPresent({ env })).toEqual(original);
    });
  });
});

describe("legacy device identity normalization", () => {
  it("normalizes valid Node PEM material and derives its canonical device id", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
    const normalized = normalizeLegacyDeviceIdentity({
      version: 1,
      deviceId: "stale-device-id",
      publicKeyPem,
      privateKeyPem,
      createdAtMs: 1_700_000_000_000,
    });

    expect(normalized).toMatchObject({
      deviceId: deriveDeviceIdFromPublicKey(publicKeyPem),
      publicKeyPem,
      privateKeyPem,
      createdAtMs: 1_700_000_000_000,
    });
  });

  it("converts valid Swift raw-key material to PEM", () => {
    const normalized = normalizeLegacyDeviceIdentity({
      deviceId: SWIFT_RAW_DEVICE_ID,
      publicKey: SWIFT_RAW_PUBLIC_KEY,
      privateKey: SWIFT_RAW_PRIVATE_KEY,
      createdAtMs: 1_700_000_000_000,
    });

    expect(normalized?.deviceId).toBe(SWIFT_RAW_DEVICE_ID);
    expect(normalized?.createdAtMs).toBe(1_700_000_000_000);
    expect(crypto.createPublicKey(normalized?.publicKeyPem ?? "").asymmetricKeyType).toBe(
      "ed25519",
    );
    expect(crypto.createPrivateKey(normalized?.privateKeyPem ?? "").asymmetricKeyType).toBe(
      "ed25519",
    );
  });

  it("rejects mismatched or malformed legacy key material", () => {
    expect(
      normalizeLegacyDeviceIdentity({
        deviceId: SWIFT_RAW_DEVICE_ID,
        publicKey: SWIFT_RAW_PUBLIC_KEY,
        privateKey: MISMATCHED_SWIFT_RAW_PRIVATE_KEY,
        createdAtMs: 1_700_000_000_000,
      }),
    ).toBeNull();
    expect(
      normalizeLegacyDeviceIdentity({
        version: 1,
        deviceId: SWIFT_RAW_DEVICE_ID,
        publicKeyPem: "not-a-key",
        privateKeyPem: "not-a-key",
        createdAtMs: Number.NaN,
      }),
    ).toBeNull();
  });
});

describe("device identity crypto helpers", () => {
  it("preserves existing public-key wire normalization", () => {
    const { publicKey } = crypto.generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
    const publicKeyRaw = publicKeyRawBase64UrlFromPem(publicKeyPem);
    const standardBase64 = `${publicKeyRaw.replaceAll("-", "+").replaceAll("_", "/")}=`;

    expect(normalizeDevicePublicKeyBase64Url(publicKeyPem)).toBe(publicKeyRaw);
    expect(normalizeDevicePublicKeyBase64Url(standardBase64)).toBe(publicKeyRaw);
    expect(normalizeDevicePublicKeyBase64Url(`${standardBase64}=`)).toBe(publicKeyRaw);
    expect(deriveDeviceIdFromPublicKey(publicKeyRaw)).toBe(
      deriveDeviceIdFromPublicKey(publicKeyPem),
    );
  });

  it("signs payloads that verify against PEM and raw public key forms", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
    const payload = JSON.stringify({ action: "system.run", ts: 1234 });
    const signature = signDevicePayload(privateKeyPem, payload);
    const publicKeyRaw = publicKeyRawBase64UrlFromPem(publicKeyPem);

    expect(verifyDeviceSignature(publicKeyPem, payload, signature)).toBe(true);
    expect(verifyDeviceSignature(publicKeyRaw, payload, signature)).toBe(true);
    expect(verifyDeviceSignature(publicKeyRaw, `${payload}!`, signature)).toBe(false);
  });
});
