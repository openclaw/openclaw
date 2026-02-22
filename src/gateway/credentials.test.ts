import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveGatewayCredentialsFromConfig } from "./credentials.js";

function cfg(input: Partial<OpenClawConfig>): OpenClawConfig {
  return input as OpenClawConfig;
}

describe("resolveGatewayCredentialsFromConfig", () => {
  it("prefers explicit credentials over config and environment", () => {
    const resolved = resolveGatewayCredentialsFromConfig({
      cfg: cfg({
        gateway: {
          auth: { token: "config-token", password: "config-password" },
        },
      }),
      env: {
        OPENCLAW_GATEWAY_TOKEN: "env-token",
        OPENCLAW_GATEWAY_PASSWORD: "env-password",
      } as NodeJS.ProcessEnv,
      explicitAuth: { token: "explicit-token", password: "explicit-password" },
    });
    expect(resolved).toEqual({
      token: "explicit-token",
      password: "explicit-password",
    });
  });

  it("returns empty credentials when url override is used without explicit auth", () => {
    const resolved = resolveGatewayCredentialsFromConfig({
      cfg: cfg({
        gateway: {
          auth: { token: "config-token", password: "config-password" },
        },
      }),
      env: {
        OPENCLAW_GATEWAY_TOKEN: "env-token",
        OPENCLAW_GATEWAY_PASSWORD: "env-password",
      } as NodeJS.ProcessEnv,
      urlOverride: "wss://example.com",
    });
    expect(resolved).toEqual({});
  });

  it("uses local-mode environment values before local config", () => {
    const resolved = resolveGatewayCredentialsFromConfig({
      cfg: cfg({
        gateway: {
          mode: "local",
          auth: { token: "config-token", password: "config-password" },
        },
      }),
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

  it("uses remote-mode remote credentials before env and local config", () => {
    const resolved = resolveGatewayCredentialsFromConfig({
      cfg: cfg({
        gateway: {
          mode: "remote",
          remote: { token: "remote-token", password: "remote-password" },
          auth: { token: "config-token", password: "config-password" },
        },
      }),
      env: {
        OPENCLAW_GATEWAY_TOKEN: "env-token",
        OPENCLAW_GATEWAY_PASSWORD: "env-password",
      } as NodeJS.ProcessEnv,
    });
    expect(resolved).toEqual({
      token: "remote-token",
      password: "remote-password",
    });
  });

  it("falls back to env/config when remote mode omits remote credentials", () => {
    const resolved = resolveGatewayCredentialsFromConfig({
      cfg: cfg({
        gateway: {
          mode: "remote",
          remote: {},
          auth: { token: "config-token", password: "config-password" },
        },
      }),
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

  it("supports env-first password override in remote mode for gateway call path", () => {
    const resolved = resolveGatewayCredentialsFromConfig({
      cfg: cfg({
        gateway: {
          mode: "remote",
          remote: { token: "remote-token", password: "remote-password" },
          auth: { token: "config-token", password: "config-password" },
        },
      }),
      env: {
        OPENCLAW_GATEWAY_TOKEN: "env-token",
        OPENCLAW_GATEWAY_PASSWORD: "env-password",
      } as NodeJS.ProcessEnv,
      remotePasswordPrecedence: "env-first",
    });
    expect(resolved).toEqual({
      token: "remote-token",
      password: "env-password",
    });
  });
});
