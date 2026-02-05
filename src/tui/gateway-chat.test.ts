import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadConfig = vi.fn();
const resolveGatewayPort = vi.fn();

const originalEnvToken = process.env.OPENCLAW_GATEWAY_TOKEN;
const originalEnvPassword = process.env.OPENCLAW_GATEWAY_PASSWORD;

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig,
    resolveGatewayPort,
  };
});

const { resolveGatewayConnection } = await import("./gateway-chat.js");

describe("resolveGatewayConnection", () => {
  beforeEach(() => {
    loadConfig.mockReset();
    resolveGatewayPort.mockReset();
    resolveGatewayPort.mockReturnValue(18789);
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;
  });

  afterEach(() => {
    if (originalEnvToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = originalEnvToken;
    }

    if (originalEnvPassword === undefined) {
      delete process.env.OPENCLAW_GATEWAY_PASSWORD;
    } else {
      process.env.OPENCLAW_GATEWAY_PASSWORD = originalEnvPassword;
    }
  });

  it("throws when url override is missing explicit credentials", () => {
    loadConfig.mockReturnValue({ gateway: { mode: "local" } });

    expect(() => resolveGatewayConnection({ url: "wss://override.example/ws" })).toThrow(
      "explicit credentials",
    );
  });

  it("uses explicit token when url override is set", () => {
    loadConfig.mockReturnValue({ gateway: { mode: "local" } });

    const result = resolveGatewayConnection({
      url: "wss://override.example/ws",
      token: "explicit-token",
    });

    expect(result).toEqual({
      url: "wss://override.example/ws",
      token: "explicit-token",
      password: undefined,
    });
  });

  it("uses explicit password when url override is set", () => {
    loadConfig.mockReturnValue({ gateway: { mode: "local" } });

    const result = resolveGatewayConnection({
      url: "wss://override.example/ws",
      password: "explicit-password",
    });

    expect(result).toEqual({
      url: "wss://override.example/ws",
      token: undefined,
      password: "explicit-password",
    });
  });
});
