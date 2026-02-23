import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv, withEnv } from "../test-utils/env.js";

const loadConfig = vi.fn();
const resolveGatewayPort = vi.fn();
const pickPrimaryTailnetIPv4 = vi.fn();
const pickPrimaryLanIPv4 = vi.fn();

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
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PASSWORD"]);
    loadConfig.mockClear();
    resolveGatewayPort.mockClear();
    pickPrimaryTailnetIPv4.mockClear();
    pickPrimaryLanIPv4.mockClear();
    resolveGatewayPort.mockReturnValue(18789);
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);
    pickPrimaryLanIPv4.mockReturnValue(undefined);
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  it("throws when url override is missing explicit credentials", () => {
    loadConfig.mockReturnValue({ gateway: { mode: "local" } });

    expect(() => resolveGatewayConnection({ url: "wss://override.example/ws" })).toThrow(
      "explicit credentials",
    );
  });

  it.each([
    {
      label: "token",
      auth: { token: "explicit-token" },
      expected: { token: "explicit-token", password: undefined },
    },
    {
      label: "password",
      auth: { password: "explicit-password" },
      expected: { token: undefined, password: "explicit-password" },
    },
  ])("uses explicit $label when url override is set", ({ auth, expected }) => {
    loadConfig.mockReturnValue({ gateway: { mode: "local" } });

    const result = resolveGatewayConnection({
      url: "wss://override.example/ws",
      ...auth,
    });

    expect(result).toEqual({
      url: "wss://override.example/ws",
      ...expected,
    });
  });

  it.each([
    {
      label: "tailnet",
      bind: "tailnet",
      setup: () => pickPrimaryTailnetIPv4.mockReturnValue("100.64.0.1"),
    },
    {
      label: "lan",
      bind: "lan",
      setup: () => pickPrimaryLanIPv4.mockReturnValue("192.168.1.42"),
    },
  ])("uses loopback host when local bind is $label", ({ bind, setup }) => {
    loadConfig.mockReturnValue({ gateway: { mode: "local", bind } });
    resolveGatewayPort.mockReturnValue(18800);
    setup();

    const result = resolveGatewayConnection({});

    expect(result.url).toBe("ws://127.0.0.1:18800");
  });

  it("uses OPENCLAW_GATEWAY_TOKEN for local mode", () => {
    loadConfig.mockReturnValue({ gateway: { mode: "local" } });

    withEnv({ OPENCLAW_GATEWAY_TOKEN: "env-token" }, () => {
      const result = resolveGatewayConnection({});
      expect(result.token).toBe("env-token");
    });
  });

  it("falls back to config auth token when env token is missing", () => {
    loadConfig.mockReturnValue({ gateway: { mode: "local", auth: { token: "config-token" } } });

    const result = resolveGatewayConnection({});
    expect(result.token).toBe("config-token");
  });

  it("prefers OPENCLAW_GATEWAY_PASSWORD over remote password fallback", () => {
    loadConfig.mockReturnValue({
      gateway: {
        mode: "remote",
        remote: { url: "wss://remote.example/ws", token: "remote-token", password: "remote-pass" },
      },
    });

    withEnv({ OPENCLAW_GATEWAY_PASSWORD: "env-pass" }, () => {
      const result = resolveGatewayConnection({});
      expect(result.password).toBe("env-pass");
    });
  });
});
