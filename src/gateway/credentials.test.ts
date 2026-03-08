import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveGatewayCredentialsFromConfig,
  resolveGatewayCredentialsFromValues,
} from "./credentials.js";

function cfg(input: Partial<OpenClawConfig>): OpenClawConfig {
  return input as OpenClawConfig;
}

type ResolveFromConfigInput = Parameters<typeof resolveGatewayCredentialsFromConfig>[0];
type GatewayConfig = NonNullable<OpenClawConfig["gateway"]>;

const DEFAULT_GATEWAY_AUTH = { token: "config-token", password: "config-password" }; // pragma: allowlist secret
const DEFAULT_REMOTE_AUTH = { token: "remote-token", password: "remote-password" }; // pragma: allowlist secret
const DEFAULT_GATEWAY_ENV = {
  OPENCLAW_GATEWAY_TOKEN: "env-token",
  OPENCLAW_GATEWAY_PASSWORD: "env-password", // pragma: allowlist secret
} as NodeJS.ProcessEnv;

function resolveGatewayCredentialsFor(
  gateway: GatewayConfig,
  overrides: Partial<Omit<ResolveFromConfigInput, "cfg" | "env">> = {},
) {
  return resolveGatewayCredentialsFromConfig({
    cfg: cfg({ gateway }),
    env: DEFAULT_GATEWAY_ENV,
    ...overrides,
  });
}

function expectEnvGatewayCredentials(resolved: { token?: string; password?: string }) {
  expect(resolved).toEqual({
    token: "env-token",
    password: "env-password", // pragma: allowlist secret
  });
}

function resolveRemoteModeWithRemoteCredentials(
  overrides: Partial<Omit<ResolveFromConfigInput, "cfg" | "env">> = {},
) {
  return resolveGatewayCredentialsFor(
    {
      mode: "remote",
      remote: DEFAULT_REMOTE_AUTH,
      auth: DEFAULT_GATEWAY_AUTH,
    },
    overrides,
  );
}

function resolveLocalModeWithUnresolvedPassword(mode: "none" | "trusted-proxy") {
  return resolveGatewayCredentialsFromConfig({
    cfg: {
      gateway: {
        mode: "local",
        auth: {
          mode,
          password: { source: "env", provider: "default", id: "MISSING_GATEWAY_PASSWORD" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig,
    env: {} as NodeJS.ProcessEnv,
    includeLegacyEnv: false,
  });
}

describe("resolveGatewayCredentialsFromConfig", () => {
  it("prefers explicit credentials over config and environment", () => {
    const resolved = resolveGatewayCredentialsFor(
      {
        auth: DEFAULT_GATEWAY_AUTH,
      },
      {
        explicitAuth: { token: "explicit-token", password: "explicit-password" }, // pragma: allowlist secret
      },
    );
    expect(resolved).toEqual({
      token: "explicit-token",
      password: "explicit-password", // pragma: allowlist secret
    });
  });

  it("returns empty credentials when url override is used without explicit auth", () => {
    const resolved = resolveGatewayCredentialsFor(
      {
        auth: DEFAULT_GATEWAY_AUTH,
      },
      {
        urlOverride: "wss://example.com",
      },
    );
    expect(resolved).toEqual({});
  });

  it("uses env credentials for env-sourced url overrides", () => {
    const resolved = resolveGatewayCredentialsFor(
      {
        auth: DEFAULT_GATEWAY_AUTH,
      },
      {
        urlOverride: "wss://example.com",
        urlOverrideSource: "env",
      },
    );
    expectEnvGatewayCredentials(resolved);
  });

  it("uses local-mode environment values before local config", () => {
    const resolved = resolveGatewayCredentialsFor({
      mode: "local",
      auth: DEFAULT_GATEWAY_AUTH,
    });
    expectEnvGatewayCredentials(resolved);
  });

  it("uses config-first local token precedence inside gateway service runtime", () => {
    const resolved = resolveGatewayCredentialsFromConfig({
      cfg: cfg({
        gateway: {
          mode: "local",
          auth: { token: "config-token", password: "config-password" }, // pragma: allowlist secret
        },
      }),
      env: {
        OPENCLAW_GATEWAY_TOKEN: "env-token",
        OPENCLAW_GATEWAY_PASSWORD: "env-password", // pragma: allowlist secret
        OPENCLAW_SERVICE_KIND: "gateway",
      } as NodeJS.ProcessEnv,
    });
    expect(resolved).toEqual({
      token: "config-token",
      password: "env-password", // pragma: allowlist secret
    });
  });

  it("falls back to remote credentials in local mode when local auth is missing", () => {
    const resolved = resolveGatewayCredentialsFromConfig({
      cfg: cfg({
        gateway: {
          mode: "local",
          remote: { token: "remote-token", password: "remote-password" }, // pragma: allowlist secret
          auth: {},
        },
      }),
      env: {} as NodeJS.ProcessEnv,
      includeLegacyEnv: false,
    });
    expect(resolved).toEqual({
      token: "remote-token",
      password: "remote-password", // pragma: allowlist secret
    });
  });

  it("throws when local password auth relies on an unresolved SecretRef", () => {
    expect(() =>
      resolveGatewayCredentialsFromConfig({
        cfg: {
          gateway: {
            mode: "local",
            auth: {
              mode: "password",
              password: { source: "env", provider: "default", id: "MISSING_GATEWAY_PASSWORD" },
            },
          },
          secrets: {
            providers: {
              default: { source: "env" },
            },
          },
        } as unknown as OpenClawConfig,
        env: {} as NodeJS.ProcessEnv,
        includeLegacyEnv: false,
      }),
    ).toThrow("gateway.auth.password");
  });

  it("treats env-template local tokens as SecretRefs instead of plaintext", () => {
    const resolved = resolveGatewayCredentialsFromConfig({
      cfg: cfg({
        gateway: {
          mode: "local",
          auth: {
            mode: "token",
            token: "${OPENCLAW_GATEWAY_TOKEN}",
          },
        },
      }),
      env: {
        OPENCLAW_GATEWAY_TOKEN: "env-token",
      } as NodeJS.ProcessEnv,
      includeLegacyEnv: false,
    });

    expect(resolved).toEqual({
      token: "env-token",
      password: undefined,
    });
  });

  it("throws when env-template local token SecretRef is unresolved in token mode", () => {
    expect(() =>
      resolveGatewayCredentialsFromConfig({
        cfg: cfg({
          gateway: {
            mode: "local",
            auth: {
              mode: "token",
              token: "${OPENCLAW_GATEWAY_TOKEN}",
            },
          },
        }),
        env: {} as NodeJS.ProcessEnv,
        includeLegacyEnv: false,
      }),
    ).toThrow("gateway.auth.token");
  });

  it("ignores unresolved local password ref when local auth mode is none", () => {
    const resolved = resolveLocalModeWithUnresolvedPassword("none");
    expect(resolved).toEqual({
      token: undefined,
      password: undefined,
    });
  });

  it("ignores unresolved local password ref when local auth mode is trusted-proxy", () => {
    const resolved = resolveLocalModeWithUnresolvedPassword("trusted-proxy");
    expect(resolved).toEqual({
      token: undefined,
      password: undefined,
    });
  });

  it("keeps local credentials ahead of remote fallback in local mode", () => {
    const resolved = resolveGatewayCredentialsFromConfig({
      cfg: cfg({
        gateway: {
          mode: "local",
          remote: { token: "remote-token", password: "remote-password" }, // pragma: allowlist secret
          auth: { token: "local-token", password: "local-password" }, // pragma: allowlist secret
        },
      }),
      env: {} as NodeJS.ProcessEnv,
      includeLegacyEnv: false,
    });
    expect(resolved).toEqual({
      token: "local-token",
      password: "local-password", // pragma: allowlist secret
    });
  });

  it("uses remote-mode remote credentials before env and local config", () => {
    const resolved = resolveRemoteModeWithRemoteCredentials();
    expect(resolved).toEqual({
      token: "remote-token",
      password: "env-password", // pragma: allowlist secret
    });
  });

  it("falls back to env/config when remote mode omits remote credentials", () => {
    const resolved = resolveGatewayCredentialsFor({
      mode: "remote",
      remote: {},
      auth: DEFAULT_GATEWAY_AUTH,
    });
    expectEnvGatewayCredentials(resolved);
  });

  it("supports env-first password override in remote mode for gateway call path", () => {
    const resolved = resolveRemoteModeWithRemoteCredentials({
      remotePasswordPrecedence: "env-first", // pragma: allowlist secret
    });
    expect(resolved).toEqual({
      token: "remote-token",
      password: "env-password", // pragma: allowlist secret
    });
  });

  it("supports env-first token precedence in remote mode", () => {
    const resolved = resolveRemoteModeWithRemoteCredentials({
      remoteTokenPrecedence: "env-first",
      remotePasswordPrecedence: "remote-first", // pragma: allowlist secret
    });
    expect(resolved).toEqual({
      token: "env-token",
      password: "remote-password", // pragma: allowlist secret
    });
  });

  it("supports remote-only password fallback for strict remote override call sites", () => {
    const resolved = resolveGatewayCredentialsFor(
      {
        mode: "remote",
        remote: { token: "remote-token" },
        auth: DEFAULT_GATEWAY_AUTH,
      },
      {
        remotePasswordFallback: "remote-only", // pragma: allowlist secret
      },
    );
    expect(resolved).toEqual({
      token: "remote-token",
      password: undefined,
    });
  });

  it("supports remote-only token fallback for strict remote override call sites", () => {
    const resolved = resolveGatewayCredentialsFromConfig({
      cfg: cfg({
        gateway: {
          mode: "remote",
          remote: { url: "wss://gateway.example" },
          auth: { token: "local-token" },
        },
      }),
      env: {
        OPENCLAW_GATEWAY_TOKEN: "env-token",
      } as NodeJS.ProcessEnv,
      remoteTokenFallback: "remote-only",
    });
    expect(resolved.token).toBeUndefined();
  });

  it("throws when remote token auth relies on an unresolved SecretRef", () => {
    expect(() =>
      resolveGatewayCredentialsFromConfig({
        cfg: {
          gateway: {
            mode: "remote",
            remote: {
              url: "wss://gateway.example",
              token: { source: "env", provider: "default", id: "MISSING_REMOTE_TOKEN" },
            },
            auth: {},
          },
          secrets: {
            providers: {
              default: { source: "env" },
            },
          },
        } as unknown as OpenClawConfig,
        env: {} as NodeJS.ProcessEnv,
        includeLegacyEnv: false,
        remoteTokenFallback: "remote-only",
      }),
    ).toThrow("gateway.remote.token");
  });

  function createRemoteConfigWithMissingLocalTokenRef() {
    return {
      gateway: {
        mode: "remote",
        remote: {
          url: "wss://gateway.example",
        },
        auth: {
          mode: "token",
          token: { source: "env", provider: "default", id: "MISSING_LOCAL_TOKEN" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    } as unknown as OpenClawConfig;
  }

  it("ignores unresolved local token ref in remote-only mode when local auth mode is token", () => {
    const resolved = resolveGatewayCredentialsFromConfig({
      cfg: createRemoteConfigWithMissingLocalTokenRef(),
      env: {} as NodeJS.ProcessEnv,
      includeLegacyEnv: false,
      remoteTokenFallback: "remote-only",
      remotePasswordFallback: "remote-only", // pragma: allowlist secret
    });
    expect(resolved).toEqual({
      token: undefined,
      password: undefined,
    });
  });

  it("throws for unresolved local token ref in remote mode when local fallback is enabled", () => {
    expect(() =>
      resolveGatewayCredentialsFromConfig({
        cfg: createRemoteConfigWithMissingLocalTokenRef(),
        env: {} as NodeJS.ProcessEnv,
        includeLegacyEnv: false,
        remoteTokenFallback: "remote-env-local",
        remotePasswordFallback: "remote-only", // pragma: allowlist secret
      }),
    ).toThrow("gateway.auth.token");
  });

  it("does not throw for unresolved remote token ref when password is available", () => {
    const resolved = resolveGatewayCredentialsFromConfig({
      cfg: {
        gateway: {
          mode: "remote",
          remote: {
            url: "wss://gateway.example",
            token: { source: "env", provider: "default", id: "MISSING_REMOTE_TOKEN" },
            password: "remote-password", // pragma: allowlist secret
          },
          auth: {},
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      } as unknown as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
      includeLegacyEnv: false,
    });
    expect(resolved).toEqual({
      token: undefined,
      password: "remote-password", // pragma: allowlist secret
    });
  });

  it("throws when remote password auth relies on an unresolved SecretRef", () => {
    expect(() =>
      resolveGatewayCredentialsFromConfig({
        cfg: {
          gateway: {
            mode: "remote",
            remote: {
              url: "wss://gateway.example",
              password: { source: "env", provider: "default", id: "MISSING_REMOTE_PASSWORD" },
            },
            auth: {},
          },
          secrets: {
            providers: {
              default: { source: "env" },
            },
          },
        } as unknown as OpenClawConfig,
        env: {} as NodeJS.ProcessEnv,
        includeLegacyEnv: false,
        remotePasswordFallback: "remote-only", // pragma: allowlist secret
      }),
    ).toThrow("gateway.remote.password");
  });

  it("can disable legacy CLAWDBOT env fallback", () => {
    const resolved = resolveGatewayCredentialsFromConfig({
      cfg: cfg({
        gateway: {
          mode: "local",
        },
      }),
      env: {
        CLAWDBOT_GATEWAY_TOKEN: "legacy-token",
        CLAWDBOT_GATEWAY_PASSWORD: "legacy-password", // pragma: allowlist secret
      } as NodeJS.ProcessEnv,
      includeLegacyEnv: false,
    });
    expect(resolved).toEqual({ token: undefined, password: undefined });
  });
});

describe("resolveGatewayCredentialsFromValues", () => {
  it("supports config-first precedence for token/password", () => {
    const resolved = resolveGatewayCredentialsFromValues({
      configToken: "config-token",
      configPassword: "config-password", // pragma: allowlist secret
      env: {
        OPENCLAW_GATEWAY_TOKEN: "env-token",
        OPENCLAW_GATEWAY_PASSWORD: "env-password", // pragma: allowlist secret
      } as NodeJS.ProcessEnv,
      includeLegacyEnv: false,
      tokenPrecedence: "config-first",
      passwordPrecedence: "config-first", // pragma: allowlist secret
    });
    expect(resolved).toEqual({
      token: "config-token",
      password: "config-password", // pragma: allowlist secret
    });
  });

  it("uses env-first precedence by default", () => {
    const resolved = resolveGatewayCredentialsFromValues({
      configToken: "config-token",
      configPassword: "config-password", // pragma: allowlist secret
      env: {
        OPENCLAW_GATEWAY_TOKEN: "env-token",
        OPENCLAW_GATEWAY_PASSWORD: "env-password", // pragma: allowlist secret
      } as NodeJS.ProcessEnv,
    });
    expect(resolved).toEqual({
      token: "env-token",
      password: "env-password", // pragma: allowlist secret
    });
  });

  it("rejects unresolved env var placeholders in config credentials", () => {
    const resolved = resolveGatewayCredentialsFromValues({
      configToken: "${OPENCLAW_GATEWAY_TOKEN}",
      configPassword: "${OPENCLAW_GATEWAY_PASSWORD}",
      env: {} as NodeJS.ProcessEnv,
      tokenPrecedence: "config-first",
      passwordPrecedence: "config-first", // pragma: allowlist secret
    });
    expect(resolved).toEqual({ token: undefined, password: undefined });
  });

  it("accepts config credentials that do not contain env var references", () => {
    const resolved = resolveGatewayCredentialsFromValues({
      configToken: "real-token-value",
      configPassword: "real-password", // pragma: allowlist secret
      env: {} as NodeJS.ProcessEnv,
      tokenPrecedence: "config-first",
      passwordPrecedence: "config-first", // pragma: allowlist secret
    });
    expect(resolved).toEqual({ token: "real-token-value", password: "real-password" }); // pragma: allowlist secret
  });

  it("normalizes non-Latin1 gateway credentials before precedence checks", () => {
    const resolved = resolveGatewayCredentialsFromValues({
      configToken: "  \u2502config-token\n",
      configPassword: "\u2502config-password", // pragma: allowlist secret
      env: {
        OPENCLAW_GATEWAY_TOKEN: "\u2502env-token",
        OPENCLAW_GATEWAY_PASSWORD: "\u2502env-password", // pragma: allowlist secret
      } as NodeJS.ProcessEnv,
    });
    expect(resolved).toEqual({
      token: "env-token",
      password: "env-password", // pragma: allowlist secret
    });
  });
});
