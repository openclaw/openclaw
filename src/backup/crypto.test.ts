import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "./crypto.js";

describe("backup/crypto", () => {
  const passphrase = "test-passphrase-42";

  it("roundtrips encrypt → decrypt", () => {
    const plaintext = Buffer.from("hello world — backup payload");
    const encrypted = encrypt(plaintext, passphrase);
    const decrypted = decrypt(encrypted, passphrase);
    expect(decrypted.toString()).toBe(plaintext.toString());
  });

  it("handles empty data", () => {
    const plaintext = Buffer.alloc(0);
    const encrypted = encrypt(plaintext, passphrase);
    const decrypted = decrypt(encrypted, passphrase);
    expect(decrypted.length).toBe(0);
  });

  it("handles large payloads", () => {
    const plaintext = Buffer.alloc(1024 * 1024, 0xab);
    const encrypted = encrypt(plaintext, passphrase);
    const decrypted = decrypt(encrypted, passphrase);
    expect(Buffer.compare(decrypted, plaintext)).toBe(0);
  });

  it("produces different ciphertext each time (random IV + salt)", () => {
    const plaintext = Buffer.from("same input");
    const a = encrypt(plaintext, passphrase);
    const b = encrypt(plaintext, passphrase);
    expect(Buffer.compare(a, b)).not.toBe(0);
  });

  it("throws on wrong passphrase", () => {
    const plaintext = Buffer.from("secret data");
    const encrypted = encrypt(plaintext, passphrase);
    expect(() => decrypt(encrypted, "wrong-passphrase")).toThrow();
  });

  it("throws when encrypted data is too short", () => {
    const tooShort = Buffer.alloc(10);
    expect(() => decrypt(tooShort, passphrase)).toThrow("encrypted data too short");
  });

  it("throws on corrupted ciphertext", () => {
    const plaintext = Buffer.from("important data");
    const encrypted = encrypt(plaintext, passphrase);
    // Flip a byte in the ciphertext portion (after salt + iv + tag = 60 bytes)
    if (encrypted.length > 61) {
      encrypted[61] ^= 0xff;
    }
    expect(() => decrypt(encrypted, passphrase)).toThrow();
  });

  it("roundtrips with unicode passphrase", () => {
    const unicodePass = "m\u1EADt-kh\u1EA9u-ti\u1EBFng-vi\u1EC7t-\u{1F512}";
    const plaintext = Buffer.from("data protected by unicode passphrase");
    const encrypted = encrypt(plaintext, unicodePass);
    const decrypted = decrypt(encrypted, unicodePass);
    expect(decrypted.toString()).toBe(plaintext.toString());
  });

  it("handles binary data with null bytes", () => {
    // Payload with embedded nulls — common in binary files
    const plaintext = Buffer.from([0x00, 0xff, 0x00, 0x42, 0x00, 0x00, 0xff, 0x01]);
    const encrypted = encrypt(plaintext, passphrase);
    const decrypted = decrypt(encrypted, passphrase);
    expect(Buffer.compare(decrypted, plaintext)).toBe(0);
  });

  it("handles data exactly at minimum header size boundary", () => {
    // salt(32) + iv(12) + tag(16) = 60 bytes header.
    // Encrypt empty data, result should be exactly 60 bytes (header-only).
    const empty = Buffer.alloc(0);
    const encrypted = encrypt(empty, passphrase);
    expect(encrypted.length).toBe(60); // header only, no ciphertext
    const decrypted = decrypt(encrypted, passphrase);
    expect(decrypted.length).toBe(0);
  });

  it("rejects buffer of exactly 59 bytes (one byte too short)", () => {
    const almostEnough = Buffer.alloc(59, 0xaa);
    expect(() => decrypt(almostEnough, passphrase)).toThrow("encrypted data too short");
  });
});
