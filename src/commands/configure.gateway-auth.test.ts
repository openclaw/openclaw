import { describe, expect, it } from "vitest";
import { buildGatewayAuthConfig } from "./configure.js";

function expectGeneratedTokenFromInput(token: string | undefined, literalToAvoid = "undefined") {
  const result = buildGatewayAuthConfig({
    mode: "token",
    token,
  });
  expect(result?.mode).toBe("token");
  expect(result?.token).toBeDefined();
  expect(result?.token).not.toBe(literalToAvoid);
  expect(typeof result?.token).toBe("string");
  expect(result?.token?.length).toBeGreaterThan(0);
}

describe("buildGatewayAuthConfig", () => {
  it("preserves allowTailscale when switching to token", () => {
    const result = buildGatewayAuthConfig({
      existing: {
        mode: "password",
        password: "secret",
        allowTailscale: true,
      },
      mode: "token",
      token: "abc",
    });

    expect(result).toEqual({ mode: "token", token: "abc", allowTailscale: true });
  });

  it("drops password when switching to token", () => {
    const result = buildGatewayAuthConfig({
      existing: {
        mode: "password",
        password: "secret",
        allowTailscale: false,
      },
      mode: "token",
      token: "abc",
    });

    expect(result).toEqual({
      mode: "token",
      token: "abc",
      allowTailscale: false,
    });
  });

  it("drops token when switching to password", () => {
    const result = buildGatewayAuthConfig({
      existing: { mode: "token", token: "abc" },
      mode: "password",
      password: "secret",
    });

    expect(result).toEqual({ mode: "password", password: "secret" });
  });

  it("does not silently omit password when literal string is provided", () => {
    const result = buildGatewayAuthConfig({
      mode: "password",
      password: "undefined",
    });

    expect(result).toEqual({ mode: "password", password: "undefined" });
  });

  it("generates random token for missing, empty, and coerced-literal token inputs", () => {
    expectGeneratedTokenFromInput(undefined);
    expectGeneratedTokenFromInput("");
    expectGeneratedTokenFromInput("   ");
    expectGeneratedTokenFromInput("undefined");
    expectGeneratedTokenFromInput("null", "null");
  });

  it("builds trusted-proxy config with all options", () => {
    const result = buildGatewayAuthConfig({
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto", "x-forwarded-host"],
        allowUsers: ["nick@example.com", "admin@company.com"],
      },
    });

    expect(result).toEqual({
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto", "x-forwarded-host"],
        allowUsers: ["nick@example.com", "admin@company.com"],
      },
    });
  });

  it("builds trusted-proxy config with only userHeader", () => {
    const result = buildGatewayAuthConfig({
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-remote-user",
      },
    });

    expect(result).toEqual({
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-remote-user",
      },
    });
  });

  it("preserves allowTailscale when switching to trusted-proxy", () => {
    const result = buildGatewayAuthConfig({
      existing: {
        mode: "token",
        token: "abc",
        allowTailscale: true,
      },
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-forwarded-user",
      },
    });

    expect(result).toEqual({
      mode: "trusted-proxy",
      allowTailscale: true,
      trustedProxy: {
        userHeader: "x-forwarded-user",
      },
    });
  });

  it("throws error when trusted-proxy mode lacks trustedProxy config", () => {
    expect(() => {
      buildGatewayAuthConfig({
        mode: "trusted-proxy",
        // missing trustedProxy
      });
    }).toThrow("trustedProxy config is required when mode is trusted-proxy");
  });

  it("drops token and password when switching to trusted-proxy", () => {
    const result = buildGatewayAuthConfig({
      existing: {
        mode: "token",
        token: "abc",
        password: "secret",
      },
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-forwarded-user",
      },
    });

    expect(result).toEqual({
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-forwarded-user",
      },
    });
    expect(result).not.toHaveProperty("token");
    expect(result).not.toHaveProperty("password");
  });
});
