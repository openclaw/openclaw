import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadConfigMock as loadConfig,
  pickPrimaryLanIPv4Mock as pickPrimaryLanIPv4,
  pickPrimaryTailnetIPv4Mock as pickPrimaryTailnetIPv4,
  resolveGatewayPortMock as resolveGatewayPort,
} from "../gateway/gateway-connection.test-mocks.js";
import { captureEnv, withEnv } from "../test-utils/env.js";

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

  it("uses loopback host when local bind is tailnet", () => {
    loadConfig.mockReturnValue({ gateway: { mode: "local", bind: "tailnet" } });
    resolveGatewayPort.mockReturnValue(18800);
    pickPrimaryTailnetIPv4.mockReturnValue("100.64.0.1");

    const result = resolveGatewayConnection({});

    expect(result.url).toBe("ws://127.0.0.1:18800");
  });

  it("uses LAN host when local bind is lan", () => {
    loadConfig.mockReturnValue({ gateway: { mode: "local", bind: "lan" } });
    resolveGatewayPort.mockReturnValue(18800);
    pickPrimaryLanIPv4.mockReturnValue("192.168.1.42");

    const result = resolveGatewayConnection({});

    expect(result.url).toBe("ws://192.168.1.42:18800");
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
