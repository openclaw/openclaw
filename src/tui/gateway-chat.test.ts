import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadConfig = vi.fn();
const resolveGatewayPort = vi.fn();
const pickPrimaryTailnetIPv4 = vi.fn();
const pickPrimaryLanIPv4 = vi.fn();

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

vi.mock("../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4,
}));

vi.mock("../gateway/net.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/net.js")>();
  return {
    ...actual,
    pickPrimaryLanIPv4,
    // Allow all URLs in tests - security validation is tested separately
    isSecureWebSocketUrl: () => true,
  };
});

const { resolveGatewayConnection } = await import("./gateway-chat.js");

describe("resolveGatewayConnection", () => {
  beforeEach(() => {
    loadConfig.mockReset();
    resolveGatewayPort.mockReset();
    pickPrimaryTailnetIPv4.mockReset();
    pickPrimaryLanIPv4.mockReset();
    resolveGatewayPort.mockReturnValue(18789);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);
    pickPrimaryLanIPv4.mockReturnValue(undefined);
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

  it("uses tailnet host when local bind is tailnet", () => {
    loadConfig.mockReturnValue({ gateway: { mode: "local", bind: "tailnet" } });
    resolveGatewayPort.mockReturnValue(18800);
    pickPrimaryTailnetIPv4.mockReturnValue("100.64.0.1");

    const result = resolveGatewayConnection({});

    expect(result.url).toBe("ws://100.64.0.1:18800");
  });

  it("uses lan host when local bind is lan", () => {
    loadConfig.mockReturnValue({ gateway: { mode: "local", bind: "lan" } });
    resolveGatewayPort.mockReturnValue(18800);
    pickPrimaryLanIPv4.mockReturnValue("192.168.1.42");

    const result = resolveGatewayConnection({});

    expect(result.url).toBe("ws://192.168.1.42:18800");
  });
});
