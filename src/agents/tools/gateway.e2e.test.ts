import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { callGatewayTool, resolveGatewayOptions } from "./gateway.js";

const callGatewayMock = vi.fn();
const configState = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));
vi.mock("../../config/config.js", () => ({
  loadConfig: () => configState.value,
  resolveGatewayPort: () => 18789,
}));
vi.mock("../../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
}));

describe("gateway tool defaults", () => {
  const envSnapshot = {
    openclaw: process.env.OPENCLAW_GATEWAY_TOKEN,
    clawdbot: process.env.CLAWDBOT_GATEWAY_TOKEN,
  };

  beforeEach(() => {
    callGatewayMock.mockReset();
    configState.value = {};
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.CLAWDBOT_GATEWAY_TOKEN;
  });

  afterAll(() => {
    if (envSnapshot.openclaw === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = envSnapshot.openclaw;
    }
    if (envSnapshot.clawdbot === undefined) {
      delete process.env.CLAWDBOT_GATEWAY_TOKEN;
    } else {
      process.env.CLAWDBOT_GATEWAY_TOKEN = envSnapshot.clawdbot;
    }
  });

  it("falls back to OPENCLAW_GATEWAY_TOKEN for allowlisted url overrides", async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token";
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    await callGatewayTool("health", { gatewayUrl: "ws://127.0.0.1:18789" }, {});

    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "ws://127.0.0.1:18789",
        token: "env-token",
        scopes: ["operator.read"],
      }),
    );
  });

  it("falls back to gateway.auth.token when env tokens are unset", async () => {
    configState.value = {
      gateway: {
        auth: { token: "config-token" },
      },
    };
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    await callGatewayTool("health", { gatewayUrl: "ws://127.0.0.1:18789" }, {});

    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "config-token",
      }),
    );
  });

  it("uses gateway.remote.token fallback for allowlisted remote overrides", async () => {
    configState.value = {
      gateway: {
        remote: {
          url: "wss://gateway.example",
          token: "remote-config-token",
        },
      },
    };
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    await callGatewayTool("health", { gatewayUrl: "wss://gateway.example" }, {});

    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "wss://gateway.example",
        token: "remote-config-token",
      }),
    );
  });

  it("does not leak local tokens to remote overrides", async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "local-env-token";
    process.env.CLAWDBOT_GATEWAY_TOKEN = "legacy-env-token";
    configState.value = {
      gateway: {
        auth: { token: "local-config-token" },
        remote: {
          url: "wss://gateway.example",
        },
      },
    };
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    await callGatewayTool("health", { gatewayUrl: "wss://gateway.example" }, {});

    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "wss://gateway.example",
        token: undefined,
      }),
    );
  });

  it("leaves url undefined so callGateway can use config", () => {
    const opts = resolveGatewayOptions();
    expect(opts.url).toBeUndefined();
  });

  it("accepts allowlisted gatewayUrl overrides (SSRF hardening)", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });
    await callGatewayTool(
      "health",
      { gatewayUrl: "ws://127.0.0.1:18789", gatewayToken: "t", timeoutMs: 5000 },
      {},
    );
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "ws://127.0.0.1:18789",
        token: "t",
        timeoutMs: 5000,
        scopes: ["operator.read"],
      }),
    );
  });

  it("uses least-privilege write scope for write methods", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });
    await callGatewayTool("wake", {}, { mode: "now", text: "hi" });
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "wake",
        scopes: ["operator.write"],
      }),
    );
  });

  it("uses admin scope only for admin methods", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });
    await callGatewayTool("cron.add", {}, { id: "job-1" });
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "cron.add",
        scopes: ["operator.admin"],
      }),
    );
  });

  it("default-denies unknown methods by sending no scopes", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });
    await callGatewayTool("nonexistent.method", {}, {});
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "nonexistent.method",
        scopes: [],
      }),
    );
  });

  it("rejects non-allowlisted overrides (SSRF hardening)", async () => {
    await expect(
      callGatewayTool("health", { gatewayUrl: "ws://127.0.0.1:8080", gatewayToken: "t" }, {}),
    ).rejects.toThrow(/gatewayUrl override rejected/i);
    await expect(
      callGatewayTool("health", { gatewayUrl: "ws://169.254.169.254", gatewayToken: "t" }, {}),
    ).rejects.toThrow(/gatewayUrl override rejected/i);
  });
});

describe("resolveGatewayOptions token resolution (integration)", () => {
  const envSnapshot = {
    openclaw: process.env.OPENCLAW_GATEWAY_TOKEN,
    clawdbot: process.env.CLAWDBOT_GATEWAY_TOKEN,
  };

  beforeEach(() => {
    configState.value = {};
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.CLAWDBOT_GATEWAY_TOKEN;
  });

  afterAll(() => {
    if (envSnapshot.openclaw === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = envSnapshot.openclaw;
    }
    if (envSnapshot.clawdbot === undefined) {
      delete process.env.CLAWDBOT_GATEWAY_TOKEN;
    } else {
      process.env.CLAWDBOT_GATEWAY_TOKEN = envSnapshot.clawdbot;
    }
  });

  it("local override: resolves env token through full fallback chain", () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token";
    const opts = resolveGatewayOptions({ gatewayUrl: "ws://127.0.0.1:18789" });
    expect(opts.url).toBe("ws://127.0.0.1:18789");
    expect(opts.token).toBe("env-token");
  });

  it("local override: falls back to legacy env token", () => {
    process.env.CLAWDBOT_GATEWAY_TOKEN = "legacy-token";
    const opts = resolveGatewayOptions({ gatewayUrl: "ws://127.0.0.1:18789" });
    expect(opts.token).toBe("legacy-token");
  });

  it("local override: falls back to config token when env tokens unset", () => {
    configState.value = { gateway: { auth: { token: "cfg-token" } } };
    const opts = resolveGatewayOptions({ gatewayUrl: "ws://127.0.0.1:18789" });
    expect(opts.token).toBe("cfg-token");
  });

  it("local override: env token takes priority over config token", () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token";
    configState.value = { gateway: { auth: { token: "cfg-token" } } };
    const opts = resolveGatewayOptions({ gatewayUrl: "ws://127.0.0.1:18789" });
    expect(opts.token).toBe("env-token");
  });

  it("remote override: uses only gateway.remote.token", () => {
    configState.value = {
      gateway: { remote: { url: "wss://remote.example", token: "remote-tok" } },
    };
    const opts = resolveGatewayOptions({ gatewayUrl: "wss://remote.example" });
    expect(opts.url).toBe("wss://remote.example");
    expect(opts.token).toBe("remote-tok");
  });

  it("remote override: returns undefined when no remote token configured", () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "local-env";
    process.env.CLAWDBOT_GATEWAY_TOKEN = "legacy-env";
    configState.value = {
      gateway: {
        auth: { token: "local-cfg" },
        remote: { url: "wss://remote.example" },
      },
    };
    const opts = resolveGatewayOptions({ gatewayUrl: "wss://remote.example" });
    expect(opts.token).toBeUndefined();
  });

  it("remote override: ignores local tokens even when all are set", () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "local-env";
    process.env.CLAWDBOT_GATEWAY_TOKEN = "legacy-env";
    configState.value = {
      gateway: {
        auth: { token: "local-cfg" },
        remote: { url: "wss://remote.example", token: "remote-tok" },
      },
    };
    const opts = resolveGatewayOptions({ gatewayUrl: "wss://remote.example" });
    expect(opts.token).toBe("remote-tok");
  });

  it("explicit gatewayToken overrides all fallback logic", () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token";
    configState.value = {
      gateway: { remote: { url: "wss://remote.example", token: "remote-tok" } },
    };
    const opts = resolveGatewayOptions({
      gatewayUrl: "wss://remote.example",
      gatewayToken: "explicit",
    });
    expect(opts.token).toBe("explicit");
  });

  it("no override: returns undefined url and token", () => {
    const opts = resolveGatewayOptions({});
    expect(opts.url).toBeUndefined();
    expect(opts.token).toBeUndefined();
  });
});
