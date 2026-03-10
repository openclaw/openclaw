import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
  resolveGatewayPort: vi.fn(() => 18789),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
  resolveGatewayPort: mocks.resolveGatewayPort,
}));
vi.mock("../../gateway/call.js", () => ({}));
vi.mock("../../gateway/credentials.js", () => ({
  resolveGatewayCredentialsFromConfig: vi.fn(),
  trimToUndefined: (v: unknown) =>
    typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined,
}));
vi.mock("../../gateway/method-scopes.js", () => ({
  resolveLeastPrivilegeOperatorScopesForMethod: vi.fn(() => []),
}));
vi.mock("../../utils/message-channel.js", () => ({
  GATEWAY_CLIENT_MODES: { BACKEND: "backend" },
  GATEWAY_CLIENT_NAMES: { GATEWAY_CLIENT: "gateway-client" },
}));
vi.mock("./common.js", () => ({
  readStringParam: vi.fn(),
}));

const { resolveGatewayTarget } = await import("./gateway.js");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function setConfig(overrides: Record<string, unknown>) {
  mocks.loadConfig.mockReturnValue(overrides);
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite: resolveGatewayTarget — env URL overrides and remote-mode fallback
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveGatewayTarget – env URL override classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setConfig({});
    delete process.env.OPENCLAW_GATEWAY_URL;
    delete process.env.CLAWDBOT_GATEWAY_URL;
  });

  afterEach(() => {
    delete process.env.OPENCLAW_GATEWAY_URL;
    delete process.env.CLAWDBOT_GATEWAY_URL;
  });

  it("returns undefined (local) with no overrides and default config", () => {
    expect(resolveGatewayTarget()).toBeUndefined();
  });

  it("returns 'remote' when gateway.mode=remote AND gateway.remote.url is set", () => {
    setConfig({
      gateway: { mode: "remote", remote: { url: "wss://remote.example.com" } },
    });
    expect(resolveGatewayTarget()).toBe("remote");
  });

  it("returns undefined when gateway.mode=remote but gateway.remote.url is missing (callGateway falls back to local)", () => {
    // This was the key regression: mode=remote without a url falls back to loopback, but the
    // old code returned "remote", causing deliveryContext to be suppressed for a local call.
    setConfig({ gateway: { mode: "remote" } });
    expect(resolveGatewayTarget()).toBeUndefined();
  });

  it("returns undefined when gateway.mode=remote but gateway.remote.url is empty string", () => {
    setConfig({ gateway: { mode: "remote", remote: { url: "  " } } });
    expect(resolveGatewayTarget()).toBeUndefined();
  });

  it("classifies OPENCLAW_GATEWAY_URL loopback env override as 'local' (no remote config)", () => {
    process.env.OPENCLAW_GATEWAY_URL = "ws://127.0.0.1:18789";
    setConfig({});
    expect(resolveGatewayTarget()).toBe("local");
  });

  it("classifies CLAWDBOT_GATEWAY_URL loopback env override as 'local' (no remote config)", () => {
    process.env.CLAWDBOT_GATEWAY_URL = "ws://localhost:18789";
    setConfig({});
    expect(resolveGatewayTarget()).toBe("local");
  });

  it("classifies loopback env URL as 'remote' when mode=remote with non-loopback remote URL (SSH tunnel, same port)", () => {
    // Common SSH tunnel pattern: ssh -N -L 18789:remote-host:18789
    // OPENCLAW_GATEWAY_URL points to the local tunnel endpoint but gateway is remote.
    process.env.OPENCLAW_GATEWAY_URL = "ws://127.0.0.1:18789";
    setConfig({
      gateway: { mode: "remote", remote: { url: "wss://remote.example.com" } },
    });
    expect(resolveGatewayTarget()).toBe("remote");
  });

  it("classifies loopback env URL with different port as 'remote' when mode=remote with non-loopback remote URL (SSH tunnel, different port)", () => {
    // SSH tunnel to a non-default port: ssh -N -L 9000:remote-host:9000
    process.env.OPENCLAW_GATEWAY_URL = "ws://127.0.0.1:9000";
    setConfig({
      gateway: { mode: "remote", remote: { url: "wss://remote.example.com" } },
    });
    expect(resolveGatewayTarget()).toBe("remote");
  });

  it("classifies loopback env URL as 'local' when mode=remote but remote.url is absent (callGateway falls back to local)", () => {
    process.env.OPENCLAW_GATEWAY_URL = "ws://127.0.0.1:18789";
    setConfig({ gateway: { mode: "remote" } });
    expect(resolveGatewayTarget()).toBe("local");
  });

  it("classifies loopback env URL as 'local' when mode=remote but remote.url is a loopback address (local-only setup)", () => {
    process.env.OPENCLAW_GATEWAY_URL = "ws://127.0.0.1:18789";
    setConfig({ gateway: { mode: "remote", remote: { url: "ws://127.0.0.1:18789" } } });
    expect(resolveGatewayTarget()).toBe("local");
  });

  it("classifies OPENCLAW_GATEWAY_URL matching gateway.remote.url as 'remote'", () => {
    process.env.OPENCLAW_GATEWAY_URL = "wss://remote.example.com";
    setConfig({
      gateway: { mode: "remote", remote: { url: "wss://remote.example.com" } },
    });
    expect(resolveGatewayTarget()).toBe("remote");
  });

  it("falls through to config-based resolution when OPENCLAW_GATEWAY_URL is rejected (malformed)", () => {
    process.env.OPENCLAW_GATEWAY_URL = "not-a-url";
    setConfig({
      gateway: { mode: "remote", remote: { url: "wss://remote.example.com" } },
    });
    // Falls through to config check: mode=remote + remote.url present → "remote"
    expect(resolveGatewayTarget()).toBe("remote");
  });

  it("classifies env-only remote URL (not matching gateway.remote.url) as 'remote'", () => {
    // callGateway uses the env URL as-is even when validateGatewayUrlOverrideForAgentTools
    // rejects it (different host than configured gateway.remote.url). Must not leak
    // deliveryContext into a remote call by falling back to 'local'.
    process.env.OPENCLAW_GATEWAY_URL = "wss://other-host.example.com";
    setConfig({
      gateway: { mode: "remote", remote: { url: "wss://remote.example.com" } },
    });
    expect(resolveGatewayTarget()).toBe("remote");
  });

  it("classifies env-only remote URL with no configured gateway.remote.url as 'remote'", () => {
    // callGateway picks up the env URL even when gateway.remote.url is absent.
    process.env.OPENCLAW_GATEWAY_URL = "wss://remote.example.com";
    setConfig({});
    expect(resolveGatewayTarget()).toBe("remote");
  });

  it("classifies env URL with /ws path (rejected by allowlist) as 'remote'", () => {
    // URLs with non-root paths are rejected by validateGatewayUrlOverrideForAgentTools but
    // callGateway/buildGatewayConnectionDetails still use them verbatim. Classify correctly.
    process.env.OPENCLAW_GATEWAY_URL = "wss://remote.example.com/ws";
    setConfig({});
    expect(resolveGatewayTarget()).toBe("remote");
  });

  it("classifies loopback env URL with /ws path (rejected by allowlist) as 'local'", () => {
    // Even with a non-root path, loopback targets remain local.
    process.env.OPENCLAW_GATEWAY_URL = "ws://127.0.0.1:18789/ws";
    setConfig({});
    expect(resolveGatewayTarget()).toBe("local");
  });

  it("OPENCLAW_GATEWAY_URL takes precedence over env CLAWDBOT_GATEWAY_URL", () => {
    process.env.OPENCLAW_GATEWAY_URL = "ws://127.0.0.1:18789";
    process.env.CLAWDBOT_GATEWAY_URL = "wss://remote.example.com";
    setConfig({
      gateway: { mode: "remote", remote: { url: "wss://remote.example.com" } },
    });
    // OPENCLAW_GATEWAY_URL wins (loopback); mode=remote with non-loopback remote.url
    // means this loopback is an SSH tunnel → "remote"
    expect(resolveGatewayTarget()).toBe("remote");
  });

  it("OPENCLAW_GATEWAY_URL takes precedence over env CLAWDBOT_GATEWAY_URL (no remote config → 'local')", () => {
    process.env.OPENCLAW_GATEWAY_URL = "ws://127.0.0.1:18789";
    process.env.CLAWDBOT_GATEWAY_URL = "wss://remote.example.com";
    setConfig({});
    // OPENCLAW_GATEWAY_URL wins (loopback), no remote config → "local"
    expect(resolveGatewayTarget()).toBe("local");
  });
});

describe("resolveGatewayTarget – explicit gatewayUrl override", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setConfig({});
    delete process.env.OPENCLAW_GATEWAY_URL;
    delete process.env.CLAWDBOT_GATEWAY_URL;
  });

  it("returns 'local' for loopback explicit gatewayUrl (no remote config)", () => {
    expect(resolveGatewayTarget({ gatewayUrl: "ws://127.0.0.1:18789" })).toBe("local");
  });

  it("returns 'remote' for explicit remote gatewayUrl matching configured remote URL", () => {
    setConfig({
      gateway: { mode: "remote", remote: { url: "wss://remote.example.com" } },
    });
    expect(resolveGatewayTarget({ gatewayUrl: "wss://remote.example.com" })).toBe("remote");
  });

  it("returns 'remote' for loopback explicit gatewayUrl when mode=remote with non-loopback remote URL (SSH tunnel)", () => {
    setConfig({
      gateway: { mode: "remote", remote: { url: "wss://remote.example.com" } },
    });
    expect(resolveGatewayTarget({ gatewayUrl: "ws://127.0.0.1:18789" })).toBe("remote");
  });
});
