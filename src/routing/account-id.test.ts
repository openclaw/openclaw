import { describe, expect, it } from "vitest";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId, normalizeOptionalAccountId } from "./account-id.js";

describe("DEFAULT_ACCOUNT_ID", () => {
  it("has correct value", () => {
    expect(DEFAULT_ACCOUNT_ID).toBe("default");
  });
});

describe("normalizeAccountId", () => {
  it("returns default for empty input", () => {
    expect(normalizeAccountId("")).toBe(DEFAULT_ACCOUNT_ID);
    expect(normalizeAccountId(null)).toBe(DEFAULT_ACCOUNT_ID);
    expect(normalizeAccountId(undefined)).toBe(DEFAULT_ACCOUNT_ID);
    expect(normalizeAccountId("   ")).toBe(DEFAULT_ACCOUNT_ID);
  });

  it("normalizes valid IDs to lowercase", () => {
    expect(normalizeAccountId("User123")).toBe("user123");
    expect(normalizeAccountId("MY-ACCOUNT")).toBe("my-account");
    expect(normalizeAccountId("test_account")).toBe("test_account");
  });

  it("replaces invalid characters", () => {
    expect(normalizeAccountId("user@domain")).toBe("user-domain");
    expect(normalizeAccountId("name with spaces")).toBe("name-with-spaces");
  });

  it("removes leading/trailing dashes", () => {
    expect(normalizeAccountId("--user--")).toBe("user");
    expect(normalizeAccountId("---")).toBe(DEFAULT_ACCOUNT_ID);
  });

  it("truncates to 64 characters", () => {
    const long = "a".repeat(100);
    const result = normalizeAccountId(long);
    expect(result.length).toBeLessThanOrEqual(64);
  });

  it("caches results", () => {
    const result1 = normalizeAccountId("TestUser");
    const result2 = normalizeAccountId("TestUser");
    expect(result1).toBe(result2);
  });
});

describe("normalizeOptionalAccountId", () => {
  it("returns undefined for empty input", () => {
    expect(normalizeOptionalAccountId("")).toBeUndefined();
    expect(normalizeOptionalAccountId(null)).toBeUndefined();
    expect(normalizeOptionalAccountId(undefined)).toBeUndefined();
    expect(normalizeOptionalAccountId("   ")).toBeUndefined();
  });

  it("normalizes valid IDs", () => {
    expect(normalizeOptionalAccountId("User123")).toBe("user123");
  });

  it("returns undefined for blocked keys", () => {
    expect(normalizeOptionalAccountId("__proto__")).toBeUndefined();
  });

  it("caches results", () => {
    const result1 = normalizeOptionalAccountId("TestAccount");
    const result2 = normalizeOptionalAccountId("TestAccount");
    expect(result1).toBe(result2);
  });
});
