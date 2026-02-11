import { describe, expect, it } from "vitest";
import { buildGatewayAuthConfig } from "./configure.js";

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

  it("throws when token is undefined", () => {
    expect(() =>
      buildGatewayAuthConfig({
        mode: "token",
        token: undefined,
      }),
    ).toThrow("Gateway token is required");
  });

  it("throws when token is empty string", () => {
    expect(() =>
      buildGatewayAuthConfig({
        mode: "token",
        token: "",
      }),
    ).toThrow("Gateway token is required");
  });

  it("throws when password is undefined", () => {
    expect(() =>
      buildGatewayAuthConfig({
        mode: "password",
        password: undefined,
      }),
    ).toThrow("Gateway password is required");
  });
});
