import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.hoisted(() => vi.fn());

vi.mock("../config/config.js", () => ({
  loadConfig: loadConfigMock,
}));

const { resolveRelayAcceptedTokensForPort } = await import("./extension-relay-auth.js");

describe("extension-relay-auth SecretRef handling", () => {
  const ENV_KEYS = ["OPENCLAW_GATEWAY_TOKEN", "CLAWDBOT_GATEWAY_TOKEN", "CUSTOM_GATEWAY_TOKEN"];
  const envSnapshot = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      envSnapshot.set(key, process.env[key]);
      delete process.env[key];
    }
    loadConfigMock.mockReset();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const previous = envSnapshot.get(key);
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });

  it("resolves env-template gateway.auth.token from its referenced env var", () => {
    loadConfigMock.mockReturnValue({
      gateway: { auth: { token: "${CUSTOM_GATEWAY_TOKEN}" } },
      secrets: { providers: { default: { source: "env" } } },
    });
    process.env.CUSTOM_GATEWAY_TOKEN = "resolved-gateway-token";

    const tokens = resolveRelayAcceptedTokensForPort(18790);

    expect(tokens).toContain("resolved-gateway-token");
    expect(tokens[0]).not.toBe("resolved-gateway-token");
  });

  it("fails closed when env-template gateway.auth.token is unresolved", () => {
    loadConfigMock.mockReturnValue({
      gateway: { auth: { token: "${CUSTOM_GATEWAY_TOKEN}" } },
      secrets: { providers: { default: { source: "env" } } },
    });

    expect(() => resolveRelayAcceptedTokensForPort(18790)).toThrow(
      "gateway.auth.token is configured as SecretRef and unavailable",
    );
  });
});
