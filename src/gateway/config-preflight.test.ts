import { describe, expect, it } from "vitest";
import { preflightGatewayConfig } from "./config-preflight.js";

describe("preflightGatewayConfig", () => {
  it("returns null for valid config with token", () => {
    const config = { gateway: { auth: { token: "test-token" } } };
    const result = preflightGatewayConfig(config);
    expect(result).toBeNull();
  });

  it("returns null for valid config with password mode", () => {
    const config = { gateway: { auth: { mode: "password" as const, password: "secret" } } };
    const result = preflightGatewayConfig(config);
    expect(result).toBeNull();
  });

  it("returns null when token comes from env", () => {
    const config = {};
    const env = { OPENCLAW_GATEWAY_TOKEN: "env-token" };
    const result = preflightGatewayConfig(config, env);
    expect(result).toBeNull();
  });

  it("returns error when token mode but no token configured", () => {
    const config = {};
    const env = {};
    const result = preflightGatewayConfig(config, env);
    expect(result).toContain("auth:");
    expect(result).toContain("token");
  });

  it("returns error when password mode but no password configured", () => {
    const config = { gateway: { auth: { mode: "password" as const } } };
    const env = {};
    const result = preflightGatewayConfig(config, env);
    expect(result).toContain("auth:");
    expect(result).toContain("password");
  });

  it("returns null for tailscale serve mode without token", () => {
    const config = { gateway: { tailscale: { mode: "serve" as const } } };
    const env = {};
    const result = preflightGatewayConfig(config, env);
    expect(result).toBeNull();
  });
});
