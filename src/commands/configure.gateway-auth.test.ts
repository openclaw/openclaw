import { describe, expect, it } from "vitest";

import { buildGatewayAuthConfig } from "./configure.js";

describe("buildGatewayAuthConfig", () => {
  it("clears token/password when auth is off", () => {
    const result = buildGatewayAuthConfig({
      existing: { mode: "token", token: "abc", password: "secret" },
      mode: "off",
    });

    expect(result).toBeUndefined();
  });

  it("preserves allowTailscale when auth is off", () => {
    const result = buildGatewayAuthConfig({
      existing: {
        mode: "token",
        token: "abc",
        allowTailscale: true,
      },
      mode: "off",
    });

    expect(result).toEqual({ allowTailscale: true });
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
});
