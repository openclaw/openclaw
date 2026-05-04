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
