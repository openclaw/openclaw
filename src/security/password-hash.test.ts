import { describe, expect, it } from "vitest";
import { hashPassword, isHashedPassword, verifyPassword } from "./password-hash.js";

describe("hashPassword", () => {
  it("produces a bcrypt hash", async () => {
    const hash = await hashPassword("test-password");
    expect(hash).toMatch(/^\$2[aby]\$\d{2}\$/);
  });

  it("produces different hashes for the same input (due to salt)", async () => {
    const hash1 = await hashPassword("same-password");
    const hash2 = await hashPassword("same-password");
    expect(hash1).not.toBe(hash2);
  });
});

describe("verifyPassword", () => {
  it("verifies a bcrypt-hashed password", async () => {
    const hash = await hashPassword("my-secret");
    const result = await verifyPassword("my-secret", hash);
    expect(result.ok).toBe(true);
    expect(result.needsRehash).toBe(false);
  });

  it("rejects wrong password against bcrypt hash", async () => {
    const hash = await hashPassword("correct-password");
    const result = await verifyPassword("wrong-password", hash);
    expect(result.ok).toBe(false);
    expect(result.needsRehash).toBe(false);
  });

  it("verifies legacy plaintext password (timing-safe)", async () => {
    const result = await verifyPassword("legacy-pass", "legacy-pass");
    expect(result.ok).toBe(true);
    expect(result.needsRehash).toBe(true);
  });

  it("rejects wrong legacy plaintext password", async () => {
    const result = await verifyPassword("wrong", "correct");
    expect(result.ok).toBe(false);
    expect(result.needsRehash).toBe(false);
  });
});

describe("isHashedPassword", () => {
  it("detects bcrypt hashes", () => {
    expect(isHashedPassword("$2a$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ.")).toBe(true);
    expect(isHashedPassword("$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ.")).toBe(true);
  });

  it("rejects plaintext", () => {
    expect(isHashedPassword("my-password")).toBe(false);
    expect(isHashedPassword("")).toBe(false);
  });
});
