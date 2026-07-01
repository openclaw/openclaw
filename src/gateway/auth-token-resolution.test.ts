// Focused regression coverage for gateway auth token precedence and SecretRef fallback.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretRef } from "../config/types.secrets.js";
import { resolveGatewayAuthToken } from "./auth-token-resolution.js";

function envSecretRef(id: string): SecretRef {
  return {
    source: "env",
    provider: "default",
    id,
  };
}

function makeConfig(token?: OpenClawConfig["gateway"]["auth"]["token"]): OpenClawConfig {
  return {
    gateway: {
      auth: token === undefined ? {} : { token },
    },
    secrets: {
      providers: {
        default: { source: "env" },
      },
    },
  } as OpenClawConfig;
}

describe("resolveGatewayAuthToken", () => {
  it("prefers explicitToken over config and env", async () => {
    await expect(
      resolveGatewayAuthToken({
        cfg: makeConfig("config-token"),
        env: {
          OPENCLAW_GATEWAY_TOKEN: "env-token",
        },
        explicitToken: "explicit-token",
      }),
    ).resolves.toEqual({
      token: "explicit-token",
      source: "explicit",
      secretRefConfigured: false,
    });
  });

  it("uses plain config token when no SecretRef is configured", async () => {
    await expect(
      resolveGatewayAuthToken({
        cfg: makeConfig("config-token"),
        env: {
          OPENCLAW_GATEWAY_TOKEN: "env-token",
        },
      }),
    ).resolves.toEqual({
      token: "config-token",
      source: "config",
      secretRefConfigured: false,
    });
  });

  it("resolves an env-backed SecretRef before the fallback env token", async () => {
    await expect(
      resolveGatewayAuthToken({
        cfg: makeConfig(envSecretRef("MY_GATEWAY_TOKEN")),
        env: {
          MY_GATEWAY_TOKEN: "secret-ref-token",
          OPENCLAW_GATEWAY_TOKEN: "env-token",
        },
      }),
    ).resolves.toEqual({
      token: "secret-ref-token",
      source: "secretRef",
      secretRefConfigured: true,
    });
  });

  it("falls back to OPENCLAW_GATEWAY_TOKEN only when envFallback=always", async () => {
    await expect(
      resolveGatewayAuthToken({
        cfg: makeConfig(envSecretRef("MISSING_GATEWAY_TOKEN")),
        env: {
          OPENCLAW_GATEWAY_TOKEN: "env-token",
        },
        envFallback: "always",
      }),
    ).resolves.toEqual({
      token: "env-token",
      source: "env",
      secretRefConfigured: true,
    });
  });

  it("keeps an unresolved SecretRef fail-closed when envFallback=no-secret-ref", async () => {
    const result = await resolveGatewayAuthToken({
      cfg: makeConfig(envSecretRef("MISSING_GATEWAY_TOKEN")),
      env: {
        OPENCLAW_GATEWAY_TOKEN: "env-token",
      },
      envFallback: "no-secret-ref",
      unresolvedReasonStyle: "detailed",
    });

    expect(result).toEqual({
      token: undefined,
      source: undefined,
      secretRefConfigured: true,
      unresolvedRefReason:
        "gateway.auth.token SecretRef is unresolved (env:default:MISSING_GATEWAY_TOKEN).",
    });
  });

  it("does not use env when no SecretRef exists and envFallback=never", async () => {
    await expect(
      resolveGatewayAuthToken({
        cfg: makeConfig(undefined),
        env: {
          OPENCLAW_GATEWAY_TOKEN: "env-token",
        },
        envFallback: "never",
      }),
    ).resolves.toEqual({
      secretRefConfigured: false,
    });
  });
});
