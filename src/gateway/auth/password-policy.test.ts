import { describe, expect, test } from "vitest";
import {
  hashPassword,
  PASSWORD_POLICY,
  validatePasswordStrength,
  verifyPassword,
} from "./password-policy.js";

describe("validatePasswordStrength", () => {
  test("accepts a strong password", () => {
    expect(validatePasswordStrength("Correct!Horse#Battery9")).toEqual({ valid: true });
  });

  test("rejects password shorter than min length", () => {
    const result = validatePasswordStrength("Sh0rt!");
    expect(result.valid).toBe(false);
    expect(
      (result as { valid: false; errors: string[] }).errors.some((e) =>
        e.includes(String(PASSWORD_POLICY.minLength)),
      ),
    ).toBe(true);
  });

  test("rejects password missing uppercase", () => {
    const result = validatePasswordStrength("correct!horse#battery9");
    expect(result.valid).toBe(false);
    expect(
      (result as { valid: false; errors: string[] }).errors.some((e) =>
        e.toLowerCase().includes("uppercase"),
      ),
    ).toBe(true);
  });

  test("rejects password missing lowercase", () => {
    const result = validatePasswordStrength("CORRECT!HORSE#BATTERY9");
    expect(result.valid).toBe(false);
  });

  test("rejects password missing digit", () => {
    const result = validatePasswordStrength("Correct!Horse#Battery");
    expect(result.valid).toBe(false);
  });

  test("rejects password missing special character", () => {
    const result = validatePasswordStrength("CorrectHorseBattery9");
    expect(result.valid).toBe(false);
  });

  test("returns all relevant errors at once", () => {
    const result = validatePasswordStrength("short");
    expect(result.valid).toBe(false);
    const errors = (result as { valid: false; errors: string[] }).errors;
    expect(errors.length).toBeGreaterThan(1);
  });
});

describe("hashPassword / verifyPassword", () => {
  test("hash and verify round-trip", async () => {
    const password = "Correct!Horse#Battery9";
    const hash = await hashPassword(password);
    expect(hash).toMatch(/^scrypt:/);
    await expect(verifyPassword(password, hash)).resolves.toBe(true);
  });

  test("wrong password returns false", async () => {
    const hash = await hashPassword("Correct!Horse#Battery9");
    await expect(verifyPassword("WrongPassword!", hash)).resolves.toBe(false);
  });

  test("two hashes of the same password differ (salt randomness)", async () => {
    const password = "Correct!Horse#Battery9";
    const h1 = await hashPassword(password);
    const h2 = await hashPassword(password);
    expect(h1).not.toBe(h2);
    // Both still verify correctly
    await expect(verifyPassword(password, h1)).resolves.toBe(true);
    await expect(verifyPassword(password, h2)).resolves.toBe(true);
  });

  test("returns false for malformed hash string", async () => {
    await expect(verifyPassword("password", "not-a-valid-hash")).resolves.toBe(false);
  });
}, 60_000);
