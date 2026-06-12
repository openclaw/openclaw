// Covers device identity creation, conversion, signing, and verification.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  deriveDeviceIdFromPublicKey,
  ED25519_RAW_PUBLIC_KEY_BYTES,
  ED25519_SIGNATURE_BYTES,
  isPlausibleDevicePublicKeyInput,
  isPlausibleDeviceSignatureInput,
  loadDeviceIdentityIfPresent,
  loadOrCreateDeviceIdentity,
  MAX_DEVICE_PUBLIC_KEY_INPUT_CHARS,
  MAX_DEVICE_SIGNATURE_INPUT_CHARS,
  normalizeDevicePublicKeyBase64Url,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
  verifyDeviceSignature,
} from "./device-identity.js";

const SWIFT_RAW_DEVICE_ID = "56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c";
const SWIFT_RAW_PUBLIC_KEY = "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=";
const SWIFT_RAW_PRIVATE_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="; // pragma: allowlist secret
const MISMATCHED_SWIFT_RAW_PRIVATE_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="; // pragma: allowlist secret

async function withIdentity(
  run: (identity: ReturnType<typeof loadOrCreateDeviceIdentity>) => void,
) {
  await withTempDir("openclaw-device-identity-", async (dir) => {
    const identity = loadOrCreateDeviceIdentity(path.join(dir, "device.json"));
    run(identity);
  });
}

describe("device identity crypto helpers", () => {
  it("loads an existing identity without creating a missing file", async () => {
    await withTempDir("openclaw-device-identity-readonly-", async (dir) => {
      const identityPath = path.join(dir, "identity", "device.json");

      expect(loadDeviceIdentityIfPresent(identityPath)).toBeNull();
      expect(fs.existsSync(identityPath)).toBe(false);

      const created = loadOrCreateDeviceIdentity(identityPath);

      expect(loadDeviceIdentityIfPresent(identityPath)).toEqual(created);
    });
  });

  it("does not repair mismatched stored device ids in read-only mode", async () => {
    await withTempDir("openclaw-device-identity-readonly-", async (dir) => {
      const identityPath = path.join(dir, "identity", "device.json");
      loadOrCreateDeviceIdentity(identityPath);
      const stored = JSON.parse(fs.readFileSync(identityPath, "utf8")) as Record<string, unknown>;
      fs.writeFileSync(
        identityPath,
        `${JSON.stringify({ ...stored, deviceId: "mismatched" }, null, 2)}\n`,
        "utf8",
      );
      const before = fs.readFileSync(identityPath, "utf8");

      expect(loadDeviceIdentityIfPresent(identityPath)).toBeNull();
      expect(fs.readFileSync(identityPath, "utf8")).toBe(before);
    });
  });

  it("loads Swift raw-key identity files without generating a new device id", async () => {
    await withTempDir("openclaw-device-identity-swift-", async (dir) => {
      const identityPath = path.join(dir, "identity", "device.json");
      fs.mkdirSync(path.dirname(identityPath), { recursive: true });
      fs.writeFileSync(
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

      const readonly = loadDeviceIdentityIfPresent(identityPath);
      const loaded = loadOrCreateDeviceIdentity(identityPath);
      const stored = JSON.parse(fs.readFileSync(identityPath, "utf8")) as Record<string, unknown>;

      expect(readonly?.deviceId).toBe(SWIFT_RAW_DEVICE_ID);
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
      expect(stored.version).toBe(1);
      expect(stored.deviceId).toBe(SWIFT_RAW_DEVICE_ID);
      expect(typeof stored.publicKeyPem).toBe("string");
      expect(typeof stored.privateKeyPem).toBe("string");
      const publicKeyPem = stored.publicKeyPem as string;
      const privateKeyPem = stored.privateKeyPem as string;
      expect(publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----\n")).toBe(true);
      expect(publicKeyPem.endsWith("-----END PUBLIC KEY-----\n")).toBe(true);
      expect(privateKeyPem.startsWith("-----BEGIN PRIVATE KEY-----\n")).toBe(true);
      expect(privateKeyPem.endsWith("-----END PRIVATE KEY-----\n")).toBe(true);
      expect(stored.createdAtMs).toBe(1_700_000_000_000);
      expect(stored).not.toHaveProperty("publicKey");
      expect(stored).not.toHaveProperty("privateKey");
    });
  });

  it("does not overwrite recognized invalid identity files", async () => {
    await withTempDir("openclaw-device-identity-invalid-", async (dir) => {
      const identityPath = path.join(dir, "identity", "device.json");
      fs.mkdirSync(path.dirname(identityPath), { recursive: true });
      fs.writeFileSync(
        identityPath,
        `${JSON.stringify(
          {
            version: 1,
            deviceId: "stale-device-id",
            publicKeyPem: "not-a-valid-public-key",
            privateKeyPem: "not-a-valid-private-key", // pragma: allowlist secret
            createdAtMs: 1_700_000_000_000,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      const before = fs.readFileSync(identityPath, "utf8");

      expect(loadDeviceIdentityIfPresent(identityPath)).toBeNull();
      const loaded = loadOrCreateDeviceIdentity(identityPath);

      expect(loaded.deviceId).not.toBe("stale-device-id");
      expect(fs.readFileSync(identityPath, "utf8")).toBe(before);
    });
  });

  it("does not migrate Swift raw-key identity files with mismatched key material", async () => {
    await withTempDir("openclaw-device-identity-swift-invalid-", async (dir) => {
      const identityPath = path.join(dir, "identity", "device.json");
      fs.mkdirSync(path.dirname(identityPath), { recursive: true });
      fs.writeFileSync(
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
      const before = fs.readFileSync(identityPath, "utf8");

      expect(loadDeviceIdentityIfPresent(identityPath)).toBeNull();
      const loaded = loadOrCreateDeviceIdentity(identityPath);

      expect(loaded.deviceId).not.toBe(SWIFT_RAW_DEVICE_ID);
      expect(fs.readFileSync(identityPath, "utf8")).toBe(before);
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

  describe("device handshake input shape pre-checks", () => {
    it("accepts every form a real Ed25519 keypair can produce", async () => {
      await withIdentity((identity) => {
        const publicKeyRaw = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
        const paddedBase64 = `${publicKeyRaw.replaceAll("-", "+").replaceAll("_", "/")}==`;
        const signature = signDevicePayload(identity.privateKeyPem, "hello");
        const signatureBase64 = Buffer.from(
          signature.replaceAll("-", "+").replaceAll("_", "/") +
            "=".repeat((4 - (signature.length % 4)) % 4),
          "base64",
        ).toString("base64");

        expect(isPlausibleDevicePublicKeyInput(identity.publicKeyPem)).toBe(true);
        expect(isPlausibleDevicePublicKeyInput(publicKeyRaw)).toBe(true);
        expect(isPlausibleDevicePublicKeyInput(paddedBase64)).toBe(true);
        expect(isPlausibleDeviceSignatureInput(signature)).toBe(true);
        expect(isPlausibleDeviceSignatureInput(signatureBase64)).toBe(true);
      });
    });

    it("rejects empty, oversized, and wrong-shape inputs without invoking crypto", () => {
      expect(isPlausibleDevicePublicKeyInput("")).toBe(false);
      expect(isPlausibleDevicePublicKeyInput(undefined)).toBe(false);
      expect(isPlausibleDevicePublicKeyInput(123)).toBe(false);
      // Non-PEM string whose base64url decode is not 32 bytes.
      expect(isPlausibleDevicePublicKeyInput("AAAA")).toBe(false);
      // Oversized non-PEM input.
      expect(
        isPlausibleDevicePublicKeyInput("a".repeat(MAX_DEVICE_PUBLIC_KEY_INPUT_CHARS + 1)),
      ).toBe(false);
      // PEM markers but oversized (would have been parsed by the slow path).
      const oversizedPem = `-----BEGIN PUBLIC KEY-----\n${"a".repeat(MAX_DEVICE_PUBLIC_KEY_INPUT_CHARS)}\n-----END PUBLIC KEY-----`;
      expect(isPlausibleDevicePublicKeyInput(oversizedPem)).toBe(false);

      expect(isPlausibleDeviceSignatureInput("")).toBe(false);
      expect(isPlausibleDeviceSignatureInput(undefined)).toBe(false);
      // 32-byte (public-key shaped) base64url is not a valid signature.
      const thirtyTwoBytesB64Url = Buffer.alloc(ED25519_RAW_PUBLIC_KEY_BYTES, 7)
        .toString("base64")
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/g, "");
      expect(isPlausibleDeviceSignatureInput(thirtyTwoBytesB64Url)).toBe(false);
      expect(
        isPlausibleDeviceSignatureInput("a".repeat(MAX_DEVICE_SIGNATURE_INPUT_CHARS + 1)),
      ).toBe(false);
    });

    it("verifyDeviceSignature short-circuits on shape failure before crypto work", async () => {
      await withIdentity((identity) => {
        const garbagePubKey = "x".repeat(MAX_DEVICE_PUBLIC_KEY_INPUT_CHARS + 1);
        const garbageSig = "y".repeat(MAX_DEVICE_SIGNATURE_INPUT_CHARS + 1);
        const validSig = signDevicePayload(identity.privateKeyPem, "hello");

        expect(verifyDeviceSignature(garbagePubKey, "hello", validSig)).toBe(false);
        expect(verifyDeviceSignature(identity.publicKeyPem, "hello", garbageSig)).toBe(false);
        // 64-byte (signature-shaped) input is not a valid public key.
        const sixtyFourBytesB64Url = Buffer.alloc(ED25519_SIGNATURE_BYTES, 1)
          .toString("base64")
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replace(/=+$/g, "");
        expect(verifyDeviceSignature(sixtyFourBytesB64Url, "hello", validSig)).toBe(false);
      });
    });
  });
});
