import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
const configState = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));
type GatewayTestConfig = {
  gateway?: {
    mode?: unknown;
    remote?: {
      url?: unknown;
    } | null;
  } | null;
};
const buildGatewayConnectionDetailsMock = vi.fn(
  ({ config }: { config?: GatewayTestConfig } = {}) => {
    const cfg = config ?? {};
    const envUrl = process.env.OPENCLAW_GATEWAY_URL?.trim();
    if (envUrl) {
      return { url: envUrl, urlSource: "env OPENCLAW_GATEWAY_URL" };
    }
    const gateway = cfg.gateway;
    const remote = gateway?.remote;
    const remoteUrl =
      gateway?.mode === "remote" &&
      remote &&
      typeof remote === "object" &&
      typeof remote.url === "string" &&
      remote.url.trim()
        ? remote.url.trim()
        : undefined;
    if (remoteUrl) {
      return { url: remoteUrl, urlSource: "config gateway.remote.url" };
    }
    const fallbackLocal =
      gateway?.mode === "remote" &&
      (!remote || typeof remote !== "object" || typeof remote.url !== "string" || !remote.url.trim());
    return {
      url: "ws://127.0.0.1:18789",
      urlSource: fallbackLocal ? "missing gateway.remote.url (fallback local)" : "local loopback",
    };
  },
);
vi.mock("../../config/config.js", () => ({
  loadConfig: () => configState.value,
  resolveGatewayPort: () => 18789,
}));
vi.mock("../../gateway/call.js", () => ({
  buildGatewayConnectionDetails: (args?: { config?: GatewayTestConfig }) =>
    buildGatewayConnectionDetailsMock(args),
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
}));
vi.mock("../../gateway/net.js", async () => await import("../../gateway/net.ts"));

let callGatewayTool: typeof import("./gateway.js").callGatewayTool;
let isRemoteGatewayTargetForAgentTools: typeof import("./gateway.js").isRemoteGatewayTargetForAgentTools;
let resolveGatewayOptions: typeof import("./gateway.js").resolveGatewayOptions;

describe("gateway tool defaults", () => {
  const envSnapshot = {
    openclaw: process.env.OPENCLAW_GATEWAY_TOKEN,
    url: process.env.OPENCLAW_GATEWAY_URL,
  };

  beforeAll(async () => {
    ({ callGatewayTool, isRemoteGatewayTargetForAgentTools, resolveGatewayOptions } =
      await import("./gateway.js"));
  });

  beforeEach(() => {
    buildGatewayConnectionDetailsMock.mockClear();
    callGatewayMock.mockClear();
    configState.value = {};
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_URL;
  });

  afterAll(() => {
    if (envSnapshot.openclaw === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = envSnapshot.openclaw;
    }
    if (envSnapshot.url === undefined) {
      delete process.env.OPENCLAW_GATEWAY_URL;
    } else {
      process.env.OPENCLAW_GATEWAY_URL = envSnapshot.url;
    }
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

  it("uses OPENCLAW_GATEWAY_TOKEN for allowlisted local overrides", () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token";
    const opts = resolveGatewayOptions({ gatewayUrl: "ws://127.0.0.1:18789" });
    expect(opts.url).toBe("ws://127.0.0.1:18789");
    expect(opts.token).toBe("env-token");
  });

  it("falls back to config gateway.auth.token when env is unset for local overrides", () => {
    configState.value = {
      gateway: {
        auth: { token: "config-token" },
      },
    };
    const opts = resolveGatewayOptions({ gatewayUrl: "ws://127.0.0.1:18789" });
    expect(opts.token).toBe("config-token");
  });

  it("uses gateway.remote.token for allowlisted remote overrides", () => {
    configState.value = {
      gateway: {
        remote: {
          url: "wss://gateway.example",
          token: "remote-token",
        },
      },
    };
    const opts = resolveGatewayOptions({ gatewayUrl: "wss://gateway.example" });
    expect(opts.url).toBe("wss://gateway.example");
    expect(opts.token).toBe("remote-token");
  });

  it("treats a loopback override that matches gateway.remote.url as remote", () => {
    configState.value = {
      gateway: {
        remote: {
          url: "ws://127.0.0.1:18789",
          token: "remote-token",
        },
      },
    };
    const opts = resolveGatewayOptions({ gatewayUrl: "ws://127.0.0.1:18789" });
    expect(opts.url).toBe("ws://127.0.0.1:18789");
    expect(opts.token).toBe("remote-token");
  });

  it("does not leak local env/config tokens to remote overrides", () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "local-env-token";
    configState.value = {
      gateway: {
        auth: { token: "local-config-token" },
        remote: {
          url: "wss://gateway.example",
        },
      },
    };
    const opts = resolveGatewayOptions({ gatewayUrl: "wss://gateway.example" });
    expect(opts.token).toBeUndefined();
  });

  it("ignores unresolved local token SecretRef for strict remote overrides", () => {
    configState.value = {
      gateway: {
        auth: {
          mode: "token",
          token: { source: "env", provider: "default", id: "MISSING_LOCAL_TOKEN" },
        },
        remote: {
          url: "wss://gateway.example",
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    };
    const opts = resolveGatewayOptions({ gatewayUrl: "wss://gateway.example" });
    expect(opts.token).toBeUndefined();
  });

  it("explicit gatewayToken overrides fallback token resolution", () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "local-env-token";
    configState.value = {
      gateway: {
        remote: {
          url: "wss://gateway.example",
          token: "remote-token",
        },
      },
    };
    const opts = resolveGatewayOptions({
      gatewayUrl: "wss://gateway.example",
      gatewayToken: "explicit-token",
    });
    expect(opts.token).toBe("explicit-token");
  });

  it("treats config-selected remote targets as remote when no override is passed", () => {
    configState.value = {
      gateway: {
        mode: "remote",
        remote: {
          url: "wss://gateway.example/ws",
        },
      },
    };

    expect(isRemoteGatewayTargetForAgentTools({ config: configState.value })).toBe(true);
  });

  it("treats OPENCLAW_GATEWAY_URL-selected targets as remote when no override is passed", () => {
    process.env.OPENCLAW_GATEWAY_URL = "wss://gateway-from-env.example/ws";

    expect(isRemoteGatewayTargetForAgentTools({ config: configState.value })).toBe(true);
  });

  it("treats OPENCLAW_GATEWAY_URL pointing to loopback as local when mode is not remote", () => {
    process.env.OPENCLAW_GATEWAY_URL = "ws://127.0.0.1:18789";

    expect(isRemoteGatewayTargetForAgentTools({ config: configState.value })).toBe(false);
  });

  it("treats non-canonical IPv4 loopback env targets as local when mode is not remote", () => {
    process.env.OPENCLAW_GATEWAY_URL = "ws://127.0.0.2:18789";

    expect(isRemoteGatewayTargetForAgentTools({ config: configState.value })).toBe(false);
  });

  it("treats IPv4-mapped IPv6 loopback env targets as local when mode is not remote", () => {
    process.env.OPENCLAW_GATEWAY_URL = "ws://[::ffff:127.0.0.1]:18789";

    expect(isRemoteGatewayTargetForAgentTools({ config: configState.value })).toBe(false);
  });

  it("treats localhost env targets with a trailing dot as local when mode is not remote", () => {
    process.env.OPENCLAW_GATEWAY_URL = "ws://localhost.:18789";

    expect(isRemoteGatewayTargetForAgentTools({ config: configState.value })).toBe(false);
  });

  it("treats OPENCLAW_GATEWAY_URL pointing to loopback as remote when mode=remote (tunneled gateway)", () => {
    process.env.OPENCLAW_GATEWAY_URL = "ws://127.0.0.1:18789";
    configState.value = { gateway: { mode: "remote" } };

    expect(isRemoteGatewayTargetForAgentTools({ config: configState.value })).toBe(true);
  });

  it("treats config-selected remote targets as remote when no config is passed (live config fallback)", () => {
    configState.value = {
      gateway: {
        mode: "remote",
        remote: {
          url: "wss://gateway.example/ws",
        },
      },
    };

    // No config passed — isRemoteGatewayTargetForAgentTools must fall back to loadConfig()
    expect(isRemoteGatewayTargetForAgentTools({})).toBe(true);
  });

  it("keeps remote-mode fallback-local targets classified as local without an override", () => {
    configState.value = {
      gateway: {
        mode: "remote",
        remote: {},
      },
    };

    expect(isRemoteGatewayTargetForAgentTools({ config: configState.value })).toBe(false);
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

  it("allows explicit scope overrides for dynamic callers", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });
    await callGatewayTool(
      "node.pair.approve",
      {},
      { requestId: "req-1" },
      { scopes: ["operator.admin"] },
    );
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "node.pair.approve",
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
