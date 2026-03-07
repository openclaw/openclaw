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

const DEFAULT_GATEWAY_AUTH = { token: "config-token", password: "config-password" };
const DEFAULT_REMOTE_AUTH = { token: "remote-token", password: "remote-password" };
const DEFAULT_GATEWAY_ENV = {
  OPENCLAW_GATEWAY_TOKEN: "env-token",
  OPENCLAW_GATEWAY_PASSWORD: "env-password",
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
    password: "env-password",
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
        explicitAuth: { token: "explicit-token", password: "explicit-password" },
      },
    );
    expect(resolved).toEqual({
      token: "explicit-token",
      password: "explicit-password",
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

  it("falls back to remote credentials in local mode when local auth is missing", () => {
    const resolved = resolveGatewayCredentialsFromConfig({
      cfg: cfg({
        gateway: {
          mode: "local",
          remote: { token: "remote-token", password: "remote-password" },
          auth: {},
        },
      }),
      env: {} as NodeJS.ProcessEnv,
      includeLegacyEnv: false,
    });
    expect(resolved).toEqual({
      token: "remote-token",
      password: "remote-password",
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
          remote: { token: "remote-token", password: "remote-password" },
          auth: { token: "local-token", password: "local-password" },
        },
      }),
      env: {} as NodeJS.ProcessEnv,
      includeLegacyEnv: false,
    });
    expect(resolved).toEqual({
      token: "local-token",
      password: "local-password",
    });
  });

  it("uses remote-mode remote credentials before env and local config", () => {
    const resolved = resolveRemoteModeWithRemoteCredentials();
    expect(resolved).toEqual({
      token: "remote-token",
      password: "env-password",
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
      remotePasswordPrecedence: "env-first",
    });
    expect(resolved).toEqual({
      token: "remote-token",
      password: "env-password",
    });
  });

  it("supports env-first token precedence in remote mode", () => {
    const resolved = resolveRemoteModeWithRemoteCredentials({
      remoteTokenPrecedence: "env-first",
      remotePasswordPrecedence: "remote-first",
    });
    expect(resolved).toEqual({
      token: "env-token",
      password: "remote-password",
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
        remotePasswordFallback: "remote-only",
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
      remotePasswordFallback: "remote-only",
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
        remotePasswordFallback: "remote-only",
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
            password: "remote-password",
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
      password: "remote-password",
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
        remotePasswordFallback: "remote-only",
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
        CLAWDBOT_GATEWAY_PASSWORD: "legacy-password",
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
      configPassword: "config-password",
      env: {
        OPENCLAW_GATEWAY_TOKEN: "env-token",
        OPENCLAW_GATEWAY_PASSWORD: "env-password",
      } as NodeJS.ProcessEnv,
      includeLegacyEnv: false,
      tokenPrecedence: "config-first",
      passwordPrecedence: "config-first",
    });
    expect(resolved).toEqual({
      token: "config-token",
      password: "config-password",
    });
  });

  it("uses env-first precedence by default", () => {
    const resolved = resolveGatewayCredentialsFromValues({
      configToken: "config-token",
      configPassword: "config-password",
      env: {
        OPENCLAW_GATEWAY_TOKEN: "env-token",
        OPENCLAW_GATEWAY_PASSWORD: "env-password",
      } as NodeJS.ProcessEnv,
    });
    expect(resolved).toEqual({
      token: "env-token",
      password: "env-password",
    });
  });
});
