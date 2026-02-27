import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "./account-id.js";

describe("account id normalization", () => {
  it("defaults missing values to default account", () => {
    expect(normalizeAccountId(undefined)).toBe(DEFAULT_ACCOUNT_ID);
    expect(normalizeAccountId(null)).toBe(DEFAULT_ACCOUNT_ID);
    expect(normalizeAccountId("   ")).toBe(DEFAULT_ACCOUNT_ID);
  });

  it("normalizes valid ids to lowercase", () => {
    expect(normalizeAccountId("  Business_1  ")).toBe("business_1");
  });

  it("sanitizes invalid characters into canonical ids", () => {
    expect(normalizeAccountId(" Prod/US East ")).toBe("prod-us-east");
  });

  it("rejects prototype-pollution key vectors", () => {
    expect(normalizeAccountId("__proto__")).toBe(DEFAULT_ACCOUNT_ID);
    expect(normalizeAccountId("constructor")).toBe(DEFAULT_ACCOUNT_ID);
    expect(normalizeAccountId("prototype")).toBe(DEFAULT_ACCOUNT_ID);
    expect(normalizeOptionalAccountId("__proto__")).toBeUndefined();
    expect(normalizeOptionalAccountId("constructor")).toBeUndefined();
    expect(normalizeOptionalAccountId("prototype")).toBeUndefined();
  });

  it("preserves optional semantics without forcing default", () => {
    expect(normalizeOptionalAccountId(undefined)).toBeUndefined();
    expect(normalizeOptionalAccountId("   ")).toBeUndefined();
    expect(normalizeOptionalAccountId(" !!! ")).toBeUndefined();
    expect(normalizeOptionalAccountId("  Business  ")).toBe("business");
  });
});
