import { describe, expect, it } from "vitest";
import { validateCredentialStrength, type ResolvedGatewayAuth } from "./auth.js";

function makeAuth(overrides: Partial<ResolvedGatewayAuth>): ResolvedGatewayAuth {
  return {
    mode: "token",
    allowTailscale: false,
    ...overrides,
  };
}

describe("validateCredentialStrength", () => {
  it("returns ok when not network-exposed", () => {
    const result = validateCredentialStrength({
      auth: makeAuth({ mode: "token", token: "short" }),
      isNetworkExposed: false,
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("warns on short token when network-exposed", () => {
    const result = validateCredentialStrength({
      auth: makeAuth({ mode: "token", token: "tooshort" }),
      isNetworkExposed: true,
    });
    expect(result.ok).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("minimum 32");
  });

  it("accepts long token", () => {
    const result = validateCredentialStrength({
      auth: makeAuth({ mode: "token", token: "a".repeat(64) }),
      isNetworkExposed: true,
    });
    expect(result.ok).toBe(true);
  });

  it("warns on short password when network-exposed", () => {
    const result = validateCredentialStrength({
      auth: makeAuth({ mode: "password", password: "abc123" }),
      isNetworkExposed: true,
    });
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => w.includes("minimum 12"))).toBe(true);
  });

  it("warns on all-digit password", () => {
    const result = validateCredentialStrength({
      auth: makeAuth({ mode: "password", password: "123456789012" }),
      isNetworkExposed: true,
    });
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => w.includes("only digits"))).toBe(true);
  });

  it("warns on all-lowercase password", () => {
    const result = validateCredentialStrength({
      auth: makeAuth({ mode: "password", password: "abcdefghijkl" }),
      isNetworkExposed: true,
    });
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => w.includes("only lowercase"))).toBe(true);
  });

  it("warns on all-uppercase password", () => {
    const result = validateCredentialStrength({
      auth: makeAuth({ mode: "password", password: "ABCDEFGHIJKL" }),
      isNetworkExposed: true,
    });
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => w.includes("only uppercase"))).toBe(true);
  });

  it("accepts strong password", () => {
    const result = validateCredentialStrength({
      auth: makeAuth({ mode: "password", password: "Str0ng!P@ssw0rd" }),
      isNetworkExposed: true,
    });
    expect(result.ok).toBe(true);
  });
});
