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

  it("generates random token when token param is undefined", () => {
    const result = buildGatewayAuthConfig({
      mode: "token",
      token: undefined,
    });

    expect(result?.mode).toBe("token");
    expect(result?.token).toBeDefined();
    expect(result?.token).not.toBe("undefined");
    expect(typeof result?.token).toBe("string");
    expect(result?.token?.length).toBeGreaterThan(0);
  });

  it("generates random token when token param is empty string", () => {
    const result = buildGatewayAuthConfig({
      mode: "token",
      token: "",
    });

    expect(result?.mode).toBe("token");
    expect(result?.token).toBeDefined();
    expect(result?.token).not.toBe("undefined");
    expect(typeof result?.token).toBe("string");
    expect(result?.token?.length).toBeGreaterThan(0);
  });

  it("generates random token when token param is whitespace only", () => {
    const result = buildGatewayAuthConfig({
      mode: "token",
      token: "   ",
    });

    expect(result?.mode).toBe("token");
    expect(result?.token).toBeDefined();
    expect(result?.token).not.toBe("undefined");
    expect(typeof result?.token).toBe("string");
    expect(result?.token?.length).toBeGreaterThan(0);
  });
});
