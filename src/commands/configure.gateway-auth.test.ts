// Configure gateway auth tests cover gateway auth config generation and token handling.
import { describe, expect, it } from "vitest";
import type { GatewayAuthConfig } from "../config/config.js";
import { buildGatewayAuthConfig } from "./configure.gateway-auth.js";

function expectGeneratedTokenFromInput(
  token: string | undefined,
  forbiddenValues: string[] = ["undefined"],
) {
  const result = buildGatewayAuthConfig({
    mode: "token",
    token,
  });
  expect(result?.mode).toBe("token");
  expect(typeof result?.token).toBe("string");
  if (typeof result?.token !== "string") {
    throw new Error("Expected generated token to be a string.");
  }
  for (const forbiddenValue of forbiddenValues) {
    expect(result.token).not.toBe(forbiddenValue);
  }
  expect(result.token.length).toBeGreaterThan(0);
}

describe("buildGatewayAuthConfig", () => {
  it.each(["token", "password", "trusted-proxy"] as const)(
    "preserves unrelated policy and replaces mode-owned fields for %s",
    (mode) => {
      const modeFields = {
        token: { token: "selected-token" },
        password: { password: "selected-password" },
        "trusted-proxy": { trustedProxy: { userHeader: "x-forwarded-user" } },
      };
      const policy: GatewayAuthConfig = {
        allowTailscale: false,
        rateLimit: {
          maxAttempts: 3,
          windowMs: 20_000,
          lockoutMs: 90_000,
          exemptLoopback: false,
        },
        identityScopes: { "operator@example.test": ["operator.read", "operator.write"] },
      };
      const existing: GatewayAuthConfig = {
        ...policy,
        mode: "password",
        token: { source: "env", provider: "default", id: "OLD_TOKEN" },
        password: "old-password",
        trustedProxy: {
          userHeader: "x-old-user",
          requiredHeaders: ["x-old-required"],
          allowUsers: ["old@example.test"],
        },
      };
      const original = structuredClone(existing);

      expect(buildGatewayAuthConfig({ existing, mode, ...modeFields[mode] })).toEqual({
        ...policy,
        mode,
        ...modeFields[mode],
      });
      expect(existing).toEqual(original);
    },
  );

  it("does not silently omit password when literal string is provided", () => {
    const result = buildGatewayAuthConfig({
      mode: "password",
      password: "undefined", // pragma: allowlist secret
    });

    expect(result).toEqual({ mode: "password", password: "undefined" }); // pragma: allowlist secret
  });

  it("generates random token for missing, empty, and coerced-literal token inputs", () => {
    expectGeneratedTokenFromInput(undefined);
    expectGeneratedTokenFromInput("", [""]);
    expectGeneratedTokenFromInput("   ", [""]);
    expectGeneratedTokenFromInput("undefined", ["undefined"]);
    expectGeneratedTokenFromInput("null", ["null"]);
  });

  it("trims and preserves explicit token values", () => {
    const result = buildGatewayAuthConfig({
      mode: "token",
      token: "  abc123  ",
    });

    expect(result).toEqual({ mode: "token", token: "abc123" });
  });

  it("trims password values before storing them", () => {
    const result = buildGatewayAuthConfig({
      mode: "password",
      password: "  secret  ", // pragma: allowlist secret
    });

    expect(result).toEqual({ mode: "password", password: "secret" }); // pragma: allowlist secret
  });

  it("keeps password mode valid even when the trimmed password becomes empty", () => {
    const result = buildGatewayAuthConfig({
      mode: "password",
      password: "   ",
    });

    expect(result).toEqual({ mode: "password" });
  });

  it("preserves SecretRef tokens when token mode is selected", () => {
    const tokenRef = {
      source: "env",
      provider: "default",
      id: "OPENCLAW_GATEWAY_TOKEN",
    } as const;
    const result = buildGatewayAuthConfig({
      mode: "token",
      token: tokenRef,
    });

    expect(result).toEqual({
      mode: "token",
      token: tokenRef,
    });
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

  it("throws error when trusted-proxy mode lacks trustedProxy config", () => {
    expect(() => {
      buildGatewayAuthConfig({
        mode: "trusted-proxy",
        // missing trustedProxy
      });
    }).toThrow("trustedProxy config is required when mode is trusted-proxy");
  });
});
