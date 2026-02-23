import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EncryptedEnvelope } from "./types.js";
import { createVault, isVaultEncrypted } from "./vault.js";

describe("vault", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeVault(passphrase = "test-passphrase-123") {
    return createVault({
      backend: "passphrase",
      stateDir: tmpDir,
      passphrase,
    });
  }

  it("encrypt → decrypt roundtrip with known plaintext", async () => {
    const vault = makeVault();
    await vault.ensureKey();

    const plaintext = '{"token":"sk-abc123","provider":"openai"}';
    const encrypted = await vault.encrypt(plaintext);
    const decrypted = await vault.decrypt(encrypted);

    expect(decrypted).toBe(plaintext);
  });

  it("tampered ciphertext returns error (auth tag mismatch)", async () => {
    const vault = makeVault();
    await vault.ensureKey();

    const plaintext = "secret-data";
    const encrypted = await vault.encrypt(plaintext);
    const envelope = JSON.parse(encrypted) as EncryptedEnvelope;

    // Tamper with ciphertext
    const buf = Buffer.from(envelope.ciphertext, "base64");
    buf[0] = buf[0] ^ 0xff;
    envelope.ciphertext = buf.toString("base64");

    await expect(vault.decrypt(JSON.stringify(envelope))).rejects.toThrow();
  });

  it("tampered IV returns error", async () => {
    const vault = makeVault();
    await vault.ensureKey();

    const plaintext = "secret-data";
    const encrypted = await vault.encrypt(plaintext);
    const envelope = JSON.parse(encrypted) as EncryptedEnvelope;

    // Tamper with IV
    const iv = Buffer.from(envelope.iv, "base64");
    iv[0] = iv[0] ^ 0xff;
    envelope.iv = iv.toString("base64");

    await expect(vault.decrypt(JSON.stringify(envelope))).rejects.toThrow();
  });

  it("wrong key returns error", async () => {
    const vault1 = makeVault("correct-passphrase");
    await vault1.ensureKey();
    const encrypted = await vault1.encrypt("secret");

    // New vault instance with different passphrase in a separate dir
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "vault-test2-"));
    try {
      const vault2 = createVault({
        backend: "passphrase",
        stateDir: tmpDir2,
        passphrase: "wrong-passphrase",
      });
      await vault2.ensureKey();

      // The per-file salt means even with a different DEK, the envelope decryption
      // uses the passphrase+salt embedded in the envelope, so wrong passphrase fails
      await expect(vault2.decrypt(encrypted)).rejects.toThrow();
    } finally {
      fs.rmSync(tmpDir2, { recursive: true, force: true });
    }
  });

  it("isEncrypted correctly identifies envelope vs plaintext", () => {
    const vault = makeVault();

    expect(vault.isEncrypted('{"version":1,"algorithm":"aes-256-gcm"')).toBe(true);
    expect(vault.isEncrypted('  {"version":1,"algorithm":"aes-256-gcm"')).toBe(true);
    expect(vault.isEncrypted('{"token":"abc"}')).toBe(false);
    expect(vault.isEncrypted("plain text")).toBe(false);
    expect(vault.isEncrypted("")).toBe(false);
  });

  it("isVaultEncrypted standalone function works", () => {
    expect(isVaultEncrypted('{"version":1,"algorithm":"aes-256-gcm"')).toBe(true);
    expect(isVaultEncrypted("not encrypted")).toBe(false);
  });

  it("migration: plaintext → isEncrypted false → save encrypts → load decrypts", async () => {
    const vault = makeVault();
    await vault.ensureKey();

    const plaintext = '{"profiles":{"openai:default":{"type":"api_key","key":"sk-123"}}}';

    // Plaintext is not recognized as encrypted
    expect(vault.isEncrypted(plaintext)).toBe(false);

    // Encrypt on save
    const encrypted = await vault.encrypt(plaintext);
    expect(vault.isEncrypted(encrypted)).toBe(true);

    // Decrypt on load
    const decrypted = await vault.decrypt(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it("key rotation: encrypt with key A → rotate to key B → decrypt with key B", async () => {
    const vault = makeVault("passphrase-A");
    await vault.ensureKey();

    const plaintext = "sensitive-credential";
    const encryptedA = await vault.encrypt(plaintext);

    // Rotate to new passphrase
    await vault.rotateKey("passphrase-B");

    // Re-encrypt with new key
    const encryptedB = await vault.encrypt(plaintext);
    const decryptedB = await vault.decrypt(encryptedB);
    expect(decryptedB).toBe(plaintext);

    // Old envelope encrypted with passphrase-A should fail with new passphrase-B
    // since each envelope carries its own salt and the passphrase changed
    await expect(vault.decrypt(encryptedA)).rejects.toThrow();
  });

  it("encrypts different data to different ciphertexts (unique IV)", async () => {
    const vault = makeVault();
    await vault.ensureKey();

    const enc1 = await vault.encrypt("data");
    const enc2 = await vault.encrypt("data");

    // Same plaintext should produce different ciphertexts due to random IV and salt
    expect(enc1).not.toBe(enc2);
  });

  it("handles empty string plaintext", async () => {
    const vault = makeVault();
    await vault.ensureKey();

    const encrypted = await vault.encrypt("");
    const decrypted = await vault.decrypt(encrypted);
    expect(decrypted).toBe("");
  });

  it("handles large plaintext", async () => {
    const vault = makeVault();
    await vault.ensureKey();

    const large = randomBytes(64 * 1024).toString("base64");
    const encrypted = await vault.encrypt(large);
    const decrypted = await vault.decrypt(encrypted);
    expect(decrypted).toBe(large);
  });

  it("invalid envelope JSON throws", async () => {
    const vault = makeVault();
    await vault.ensureKey();

    await expect(vault.decrypt("not json")).rejects.toThrow();
    await expect(vault.decrypt('{"version":2}')).rejects.toThrow();
    await expect(vault.decrypt('{"version":1}')).rejects.toThrow();
  });

  it("vault without passphrase in passphrase mode throws", async () => {
    const vault = createVault({
      backend: "passphrase",
      stateDir: tmpDir,
    });

    await expect(vault.ensureKey()).rejects.toThrow(/passphrase required/i);
  });
});
