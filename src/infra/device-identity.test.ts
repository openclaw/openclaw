import crypto from "node:crypto";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
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

const createdAtMs = 1_700_000_000_000;
const swiftIdentity = {
  deviceId: SWIFT_RAW_DEVICE_ID,
  publicKey: SWIFT_RAW_PUBLIC_KEY,
  privateKey: SWIFT_RAW_PRIVATE_KEY,
  createdAtMs,
};
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const pemKeys = {
  publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
  privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
};
const legacyPem = { ...pemKeys, version: 1, deviceId: "stale-device-id", createdAtMs };
const withIdentityStore = (run: (env: NodeJS.ProcessEnv, dir: string) => void) =>
  withTempDir("openclaw-identity-", async (dir) => run({ OPENCLAW_STATE_DIR: dir }, dir));

describe("local device identity owner", () => {
  it("reads missing credentials without creating shared or local state", async () => {
    await withIdentityStore((env, stateDir) => {
      expect(loadDeviceIdentityIfPresent({ env })).toBeNull();
      expect(fs.readdirSync(stateDir)).toEqual([]);
    });
  });

  it("fails closed on corrupt persisted identity and lets Doctor preserve matching keys", async () => {
    await withIdentityStore((env) => {
      const original = loadOrCreateDeviceIdentity({ env });
      withClientCredentialStore(env, false, (db) => {
        db.prepare("UPDATE device_identities SET device_id = ? WHERE identity_key = ?").run(
          "corrupt",
          "primary",
        );
      });
      for (const load of [loadDeviceIdentityIfPresent, loadOrCreateDeviceIdentity]) {
        expect(() => load({ env })).toThrow("invalid persisted device identity");
      }
      const repaired = repairInvalidStoredDeviceIdentity(generateStoredDeviceIdentity(), { env });
      expect(repaired).toMatchObject({ repaired: true, rotated: false });
      expect(loadDeviceIdentityIfPresent({ env })).toEqual(original);
    });
  });
});

describe("legacy device identity normalization", () => {
  it("normalizes valid Node PEM material and derives its canonical device id", () => {
    expect(normalizeLegacyDeviceIdentity(legacyPem)).toMatchObject({
      ...pemKeys,
      createdAtMs,
      deviceId: deriveDeviceIdFromPublicKey(pemKeys.publicKeyPem),
    });
  });

  it("rejects mismatched or malformed legacy key material", () => {
    expect(
      normalizeLegacyDeviceIdentity({
        ...swiftIdentity,
        privateKey: MISMATCHED_SWIFT_RAW_PRIVATE_KEY,
      }),
    ).toBeNull();
    expect(
      normalizeLegacyDeviceIdentity({
        ...legacyPem,
        publicKeyPem: "not-a-key",
        privateKeyPem: "not-a-key",
        createdAtMs: Number.NaN,
      }),
    ).toBeNull();
  });
});

describe("device identity crypto helpers", () => {
  it("preserves existing public-key wire normalization", () => {
    const { publicKeyPem } = pemKeys;
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
    const { publicKeyPem, privateKeyPem } = pemKeys;
    const payload = JSON.stringify({ action: "system.run", ts: 1234 });
    const signature = signDevicePayload(privateKeyPem, payload);
    const publicKeyRaw = publicKeyRawBase64UrlFromPem(publicKeyPem);

    expect(verifyDeviceSignature(publicKeyPem, payload, signature)).toBe(true);
    expect(verifyDeviceSignature(publicKeyRaw, payload, signature)).toBe(true);
    expect(verifyDeviceSignature(publicKeyRaw, `${payload}!`, signature)).toBe(false);
  });
});
