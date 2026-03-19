import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SecretInput } from "../config/types.secrets.js";

vi.mock("../infra/device-bootstrap.js", () => ({
  issueDeviceBootstrapToken: vi.fn(async () => ({
    token: "bootstrap-123",
    expiresAtMs: 123,
  })),
}));

let encodePairingSetupCode: typeof import("./setup-code.js").encodePairingSetupCode;
let resolvePairingSetupFromConfig: typeof import("./setup-code.js").resolvePairingSetupFromConfig;

describe("pairing setup code", () => {
  type ResolvedSetup = Awaited<ReturnType<typeof resolvePairingSetupFromConfig>>;
  const defaultEnvSecretProviderConfig = {
    secrets: {
      providers: {
        default: { source: "env" },
      },
    },
  } as const;
  const gatewayPasswordSecretRef: SecretInput = {
    source: "env",
    provider: "default",
    id: "GW_PASSWORD",
  };
  const missingGatewayTokenSecretRef: SecretInput = {
    source: "env",
    provider: "default",
    id: "MISSING_GW_TOKEN",
  };

  function createTailnetDnsRunner() {
    return vi.fn(async () => ({
      code: 0,
      stdout: '{"Self":{"DNSName":"mb-server.tailnet.ts.net."}}',
      stderr: "",
    }));
  }

  function expectResolvedSetupOk(
    resolved: ResolvedSetup,
    params: {
      authLabel: string;
      url?: string;
      urlSource?: string;
      token?: string;
      password?: string;
    },
  ) {
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      throw new Error("expected setup resolution to succeed");
    }
    expect(resolved.authLabel).toBe(params.authLabel);
    expect(resolved.payload.bootstrapToken).toBe("bootstrap-123");
    expect(resolved.payload.token).toBe(params.token);
    expect(resolved.payload.password).toBe(params.password);
    if (params.url) {
      expect(resolved.payload.url).toBe(params.url);
    }
    if (params.urlSource) {
      expect(resolved.urlSource).toBe(params.urlSource);
    }
  }

  function expectResolvedSetupError(resolved: ResolvedSetup, snippet: string) {
    expect(resolved.ok).toBe(false);
    if (resolved.ok) {
      throw new Error("expected setup resolution to fail");
    }
    expect(resolved.error).toContain(snippet);
  }

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "");
    vi.stubEnv("CLAWDBOT_GATEWAY_TOKEN", "");
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "");
    vi.stubEnv("CLAWDBOT_GATEWAY_PASSWORD", "");
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", "");
    vi.stubEnv("CLAWDBOT_GATEWAY_PORT", "");
  });

  beforeEach(async () => {
    ({ encodePairingSetupCode, resolvePairingSetupFromConfig } = await import("./setup-code.js"));
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
        token: "tok_123",
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
            password: gatewayPasswordSecretRef,
          },
        },
        ...defaultEnvSecretProviderConfig,
      },
      {
        env: {
          GW_PASSWORD: "resolved-password", // pragma: allowlist secret
        },
      },
    );

    expectResolvedSetupOk(resolved, { authLabel: "password", password: "resolved-password" });
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
        ...defaultEnvSecretProviderConfig,
      },
      {
        env: {
          OPENCLAW_GATEWAY_PASSWORD: "password-from-env", // pragma: allowlist secret
        },
      },
    );

    expectResolvedSetupOk(resolved, { authLabel: "password", password: "password-from-env" });
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
        ...defaultEnvSecretProviderConfig,
      },
      {
        env: {},
      },
    );

    expectResolvedSetupOk(resolved, { authLabel: "token", token: "tok_123" });
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
        ...defaultEnvSecretProviderConfig,
      },
      {
        env: {
          GW_TOKEN: "resolved-token",
        },
      },
    );

    expectResolvedSetupOk(resolved, { authLabel: "token", token: "resolved-token" });
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
              token: missingGatewayTokenSecretRef,
            },
          },
          ...defaultEnvSecretProviderConfig,
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
        ...defaultEnvSecretProviderConfig,
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

    expectResolvedSetupOk(resolved, { authLabel: "password", password: "password-from-env" });
  });

  it("does not treat env-template token as plaintext in inferred mode", async () => {
    const resolved = await resolveInferredModeWithPasswordEnv("${MISSING_GW_TOKEN}");

    expectResolvedSetupOk(resolved, { authLabel: "password", password: "password-from-env" });
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
              password: gatewayPasswordSecretRef,
            },
          },
          ...defaultEnvSecretProviderConfig,
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
              token: missingGatewayTokenSecretRef,
              password: gatewayPasswordSecretRef,
            },
          },
          ...defaultEnvSecretProviderConfig,
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

    expectResolvedSetupOk(resolved, { authLabel: "token", token: "new-token" });
  });

  it("errors when gateway is loopback only", async () => {
    const resolved = await resolvePairingSetupFromConfig({
      gateway: {
        bind: "loopback",
        auth: { mode: "token", token: "tok" },
      },
    });

    expectResolvedSetupError(resolved, "only bound to loopback");
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
        password: "secret",
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
        token: "tok_123",
      },
      authLabel: "token",
      urlSource: "gateway.remote.url",
    });
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });
});
