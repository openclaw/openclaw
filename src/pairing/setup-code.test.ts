import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SecretInput } from "../config/types.secrets.js";
import { encodePairingSetupCode, resolvePairingSetupFromConfig } from "./setup-code.js";

vi.mock("../infra/device-bootstrap.js", () => ({
  issueDeviceBootstrapToken: vi.fn(async () => ({
    token: "bootstrap-123",
    expiresAtMs: 123,
  })),
}));

describe("pairing setup code", () => {
  function createTailnetDnsRunner() {
    return vi.fn(async () => ({
      code: 0,
      stdout: '{"Self":{"DNSName":"mb-server.tailnet.ts.net."}}',
      stderr: "",
    }));
  }

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "");
    vi.stubEnv("CLAWDBOT_GATEWAY_TOKEN", "");
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "");
    vi.stubEnv("CLAWDBOT_GATEWAY_PASSWORD", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("encodes payload as base64url JSON", () => {
    const code = encodePairingSetupCode({
      url: "wss://gateway.example.com:443",
      bootstrapToken: "abc",
    });

    expect(code).toBe(
      "eyJ1cmwiOiJ3c3M6Ly9nYXRld2F5LmV4YW1wbGUuY29tOjQ0MyIsImJvb3RzdHJhcFRva2VuIjoiYWJjIn0",
    );
  });

  it("resolves custom bind + token auth", async () => {
    const resolved = await resolvePairingSetupFromConfig({
      gateway: {
        bind: "custom",
        customBindHost: "gateway.local",
        port: 19001,
        auth: { mode: "token", token: "tok_123" },
      },
    });

    expect(resolved).toEqual({
      ok: true,
      payload: {
        url: "ws://gateway.local:19001",
        bootstrapToken: "bootstrap-123",
      },
      authLabel: "token",
      urlSource: "gateway.bind=custom",
    });
  });

  it("resolves gateway.auth.password SecretRef for pairing payload", async () => {
    const resolved = await resolvePairingSetupFromConfig(
      {
        gateway: {
          bind: "custom",
          customBindHost: "gateway.local",
          auth: {
            mode: "password",
            password: { source: "env", provider: "default", id: "GW_PASSWORD" },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      },
      {
        env: {
          GW_PASSWORD: "resolved-password", // pragma: allowlist secret
        },
      },
    );

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      throw new Error("expected setup resolution to succeed");
    }
    expect(resolved.payload.bootstrapToken).toBe("bootstrap-123");
    expect(resolved.authLabel).toBe("password");
  });

  it("uses OPENCLAW_GATEWAY_PASSWORD without resolving configured password SecretRef", async () => {
    const resolved = await resolvePairingSetupFromConfig(
      {
        gateway: {
          bind: "custom",
          customBindHost: "gateway.local",
          auth: {
            mode: "password",
            password: { source: "env", provider: "default", id: "MISSING_GW_PASSWORD" },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      },
      {
        env: {
          OPENCLAW_GATEWAY_PASSWORD: "password-from-env", // pragma: allowlist secret
        },
      },
    );

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      throw new Error("expected setup resolution to succeed");
    }
    expect(resolved.payload.bootstrapToken).toBe("bootstrap-123");
    expect(resolved.authLabel).toBe("password");
  });

  it("does not resolve gateway.auth.password SecretRef in token mode", async () => {
    const resolved = await resolvePairingSetupFromConfig(
      {
        gateway: {
          bind: "custom",
          customBindHost: "gateway.local",
          auth: {
            mode: "token",
            token: "tok_123",
            password: { source: "env", provider: "missing", id: "GW_PASSWORD" },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      },
      {
        env: {},
      },
    );

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      throw new Error("expected setup resolution to succeed");
    }
    expect(resolved.authLabel).toBe("token");
    expect(resolved.payload.bootstrapToken).toBe("bootstrap-123");
  });

  it("resolves gateway.auth.token SecretRef for pairing payload", async () => {
    const resolved = await resolvePairingSetupFromConfig(
      {
        gateway: {
          bind: "custom",
          customBindHost: "gateway.local",
          auth: {
            mode: "token",
            token: { source: "env", provider: "default", id: "GW_TOKEN" },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      },
      {
        env: {
          GW_TOKEN: "resolved-token",
        },
      },
    );

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      throw new Error("expected setup resolution to succeed");
    }
    expect(resolved.authLabel).toBe("token");
    expect(resolved.payload.bootstrapToken).toBe("bootstrap-123");
  });

  it("errors when gateway.auth.token SecretRef is unresolved in token mode", async () => {
    await expect(
      resolvePairingSetupFromConfig(
        {
          gateway: {
            bind: "custom",
            customBindHost: "gateway.local",
            auth: {
              mode: "token",
              token: { source: "env", provider: "default", id: "MISSING_GW_TOKEN" },
            },
          },
          secrets: {
            providers: {
              default: { source: "env" },
            },
          },
        },
        {
          env: {},
        },
      ),
    ).rejects.toThrow(/MISSING_GW_TOKEN/i);
  });

  async function resolveInferredModeWithPasswordEnv(token: SecretInput) {
    return await resolvePairingSetupFromConfig(
      {
        gateway: {
          bind: "custom",
          customBindHost: "gateway.local",
          auth: { token },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      },
      {
        env: {
          OPENCLAW_GATEWAY_PASSWORD: "password-from-env", // pragma: allowlist secret
        },
      },
    );
  }

  it("uses password env in inferred mode without resolving token SecretRef", async () => {
    const resolved = await resolveInferredModeWithPasswordEnv({
      source: "env",
      provider: "default",
      id: "MISSING_GW_TOKEN",
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      throw new Error("expected setup resolution to succeed");
    }
    expect(resolved.authLabel).toBe("password");
    expect(resolved.payload.bootstrapToken).toBe("bootstrap-123");
  });

  it("does not treat env-template token as plaintext in inferred mode", async () => {
    const resolved = await resolveInferredModeWithPasswordEnv("${MISSING_GW_TOKEN}");

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      throw new Error("expected setup resolution to succeed");
    }
    expect(resolved.authLabel).toBe("password");
    expect(resolved.payload.bootstrapToken).toBe("bootstrap-123");
  });

  it("requires explicit auth mode when token and password are both configured", async () => {
    await expect(
      resolvePairingSetupFromConfig(
        {
          gateway: {
            bind: "custom",
            customBindHost: "gateway.local",
            auth: {
              token: { source: "env", provider: "default", id: "GW_TOKEN" },
              password: { source: "env", provider: "default", id: "GW_PASSWORD" },
            },
          },
          secrets: {
            providers: {
              default: { source: "env" },
            },
          },
        },
        {
          env: {
            GW_TOKEN: "resolved-token",
            GW_PASSWORD: "resolved-password", // pragma: allowlist secret
          },
        },
      ),
    ).rejects.toThrow(/gateway\.auth\.mode is unset/i);
  });

  it("errors when token and password SecretRefs are both configured with inferred mode", async () => {
    await expect(
      resolvePairingSetupFromConfig(
        {
          gateway: {
            bind: "custom",
            customBindHost: "gateway.local",
            auth: {
              token: { source: "env", provider: "default", id: "MISSING_GW_TOKEN" },
              password: { source: "env", provider: "default", id: "GW_PASSWORD" },
            },
          },
          secrets: {
            providers: {
              default: { source: "env" },
            },
          },
        },
        {
          env: {
            GW_PASSWORD: "resolved-password", // pragma: allowlist secret
          },
        },
      ),
    ).rejects.toThrow(/gateway\.auth\.mode is unset/i);
  });

  it("honors env token override", async () => {
    const resolved = await resolvePairingSetupFromConfig(
      {
        gateway: {
          bind: "custom",
          customBindHost: "gateway.local",
          auth: { mode: "token", token: "old" },
        },
      },
      {
        env: {
          OPENCLAW_GATEWAY_TOKEN: "new-token",
        },
      },
    );

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      throw new Error("expected setup resolution to succeed");
    }
    expect(resolved.payload.bootstrapToken).toBe("bootstrap-123");
  });

  it("errors when gateway is loopback only", async () => {
    const resolved = await resolvePairingSetupFromConfig({
      gateway: {
        bind: "loopback",
        auth: { mode: "token", token: "tok" },
      },
    });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) {
      throw new Error("expected setup resolution to fail");
    }
    expect(resolved.error).toContain("only bound to loopback");
  });

  it("uses tailscale serve DNS when available", async () => {
    const runCommandWithTimeout = createTailnetDnsRunner();

    const resolved = await resolvePairingSetupFromConfig(
      {
        gateway: {
          tailscale: { mode: "serve" },
          auth: { mode: "password", password: "secret" },
        },
      },
      {
        runCommandWithTimeout,
      },
    );

    expect(resolved).toEqual({
      ok: true,
      payload: {
        url: "wss://mb-server.tailnet.ts.net",
        bootstrapToken: "bootstrap-123",
      },
      authLabel: "password",
      urlSource: "gateway.tailscale.mode=serve",
    });
  });

  it("prefers gateway.remote.url over tailscale when requested", async () => {
    const runCommandWithTimeout = createTailnetDnsRunner();

    const resolved = await resolvePairingSetupFromConfig(
      {
        gateway: {
          tailscale: { mode: "serve" },
          remote: { url: "wss://remote.example.com:444" },
          auth: { mode: "token", token: "tok_123" },
        },
      },
      {
        preferRemoteUrl: true,
        runCommandWithTimeout,
      },
    );

    expect(resolved).toEqual({
      ok: true,
      payload: {
        url: "wss://remote.example.com:444",
        bootstrapToken: "bootstrap-123",
      },
      authLabel: "token",
      urlSource: "gateway.remote.url",
    });
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });
});
