// Startup auth tests cover weak-token rejection, startup auth repair, env secret
// references, and merged Tailscale gateway auth config.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { REDACTED_SENTINEL } from "../config/redact-sentinel.js";
import { getConfigResolutionFacts, setConfigResolutionFacts } from "../config/resolution-facts.js";
import { applyGatewayAuthOverridesForStartupPreflight } from "./server-startup-config-helpers.js";
import { ensureGatewayStartupAuth, mergeGatewayTailscaleConfig } from "./startup-auth.js";

const KNOWN_WEAK_GATEWAY_TOKEN_PLACEHOLDERS = [
  "change-me-to-a-long-random-token",
  "change-me-now",
  "undefined",
  "null",
] as const;

const mocks = vi.hoisted(() => ({
  replaceConfigFile: vi.fn(async (_params: { nextConfig: OpenClawConfig }) => {}),
}));

vi.mock("../config/mutate.js", async () => {
  const actual = await vi.importActual<typeof import("../config/mutate.js")>("../config/mutate.js");
  return {
    ...actual,
    replaceConfigFile: mocks.replaceConfigFile,
  };
});

type StartupAuthInput = Parameters<typeof ensureGatewayStartupAuth>[0];
type StartupAuthResult = Awaited<ReturnType<typeof ensureGatewayStartupAuth>>;
type GatewayAuthConfig = NonNullable<NonNullable<OpenClawConfig["gateway"]>["auth"]>;

function emptyEnv(): NodeJS.ProcessEnv {
  return {} as NodeJS.ProcessEnv;
}

function gatewayEnvSecretRef(id: string) {
  return { source: "env" as const, provider: "default", id };
}

function gatewayAuthConfig(auth: GatewayAuthConfig): OpenClawConfig {
  return {
    gateway: { auth },
  };
}

function gatewayAuthConfigWithDefaultEnvProvider(auth: GatewayAuthConfig): OpenClawConfig {
  return {
    ...gatewayAuthConfig(auth),
    secrets: {
      providers: {
        default: { source: "env" },
      },
    },
  };
}

describe("mergeGatewayTailscaleConfig", () => {
  it("preserves explicit preserveFunnel overrides", () => {
    expect(
      mergeGatewayTailscaleConfig(
        { mode: "serve", preserveFunnel: false },
        { preserveFunnel: true },
      ),
    ).toEqual({ mode: "serve", preserveFunnel: true });
  });
});

describe("ensureGatewayStartupAuth", () => {
  it.each(["config", "environment"])(
    "allows trusted-proxy startup with a redacted optional password from %s",
    async (source) => {
      const warn = vi.fn();
      const result = await ensureGatewayStartupAuth({
        cfg: gatewayAuthConfig({
          mode: "trusted-proxy",
          trustedProxy: { userHeader: "x-forwarded-user" },
          ...(source === "config" ? { password: REDACTED_SENTINEL } : {}),
        }),
        env: source === "environment" ? { OPENCLAW_GATEWAY_PASSWORD: REDACTED_SENTINEL } : {},
        warn,
      });
      expect(result.auth.mode).toBe("trusted-proxy");
      expect(result.generatedToken).toBeUndefined();
      expect(result.persistedGeneratedToken).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("local password fallback"));
      expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    },
  );

  it.each(["inline", "ref"])(
    "refuses a redacted %s Gateway token and points to Doctor without generating a replacement",
    async (source) => {
      await expect(
        ensureGatewayStartupAuth({
          cfg: gatewayAuthConfigWithDefaultEnvProvider({
            mode: "token",
            token:
              source === "inline"
                ? REDACTED_SENTINEL
                : gatewayEnvSecretRef("OPENCLAW_GATEWAY_TOKEN"),
            allowTailscale: true,
          }),
          env: { OPENCLAW_GATEWAY_TOKEN: REDACTED_SENTINEL },
        }),
      ).rejects.toThrow(/redaction (?:sentinel|placeholder).*doctor --fix/);
      expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    },
  );

  async function runStartupAuth(
    params: Omit<StartupAuthInput, "env"> & { env?: NodeJS.ProcessEnv },
  ) {
    return ensureGatewayStartupAuth({
      env: emptyEnv(),
      ...params,
    });
  }

  function expectNoGeneratedToken(result: StartupAuthResult) {
    expect(result.generatedToken).toBeUndefined();
    expect(result.persistedGeneratedToken).toBe(false);
  }

  function expectEphemeralGeneratedToken(result: StartupAuthResult) {
    expect(result.generatedToken).toMatch(/^[0-9a-f]{48}$/);
    expect(result.persistedGeneratedToken).toBe(false);
    expect(result.auth.mode).toBe("token");
    expect(result.auth.token).toBe(result.generatedToken);
  }

  function expectResolvedPassword(result: StartupAuthResult, password: string) {
    expectNoGeneratedToken(result);
    expect(result.auth.mode).toBe("password");
    expect(result.auth.password).toBe(password);
  }

  async function expectEphemeralGeneratedTokenWhenOverridden(cfg: OpenClawConfig) {
    const result = await runStartupAuth({
      cfg,
      authOverride: { mode: "token" },
      persist: true,
    });

    expectEphemeralGeneratedToken(result);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.replaceConfigFile.mockClear();
  });

  async function expectNoTokenGeneration(cfg: OpenClawConfig, mode: string) {
    const result = await runStartupAuth({
      cfg,
      persist: true,
    });

    expectNoGeneratedToken(result);
    expect(result.auth.mode).toBe(mode);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  }

  async function expectResolvedToken(params: {
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    authOverride?: StartupAuthInput["authOverride"];
    expectedToken: string;
    expectedConfiguredToken?: unknown;
  }) {
    const result = await runStartupAuth({
      cfg: params.cfg,
      env: params.env,
      authOverride: params.authOverride,
      persist: true,
    });

    expectNoGeneratedToken(result);
    expect(result.auth.mode).toBe("token");
    expect(result.auth.token).toBe(params.expectedToken);
    if ("expectedConfiguredToken" in params) {
      expect(result.cfg.gateway?.auth?.token).toEqual(params.expectedConfiguredToken);
    }
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  }

  function createMissingGatewayTokenSecretRefConfig(): OpenClawConfig {
    return gatewayAuthConfigWithDefaultEnvProvider({
      mode: "token",
      token: gatewayEnvSecretRef("MISSING_GW_TOKEN"),
    });
  }

  it("generates a runtime token without persisting when startup auth is missing", async () => {
    const result = await runStartupAuth({
      cfg: {},
      persist: true,
    });

    expectEphemeralGeneratedToken(result);
    expect(result.cfg.gateway?.auth?.token).toBe(result.generatedToken);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("generates a safe token when the configured token substitution is missing", async () => {
    const config = gatewayAuthConfig({ mode: "token", token: "${MISSING_GATEWAY_TOKEN}" });
    setConfigResolutionFacts(config, new Set(["gateway.auth.token"]));

    const result = await runStartupAuth({ cfg: config, env: emptyEnv() });

    expectEphemeralGeneratedToken(result);
    expect(getConfigResolutionFacts(result.cfg)?.has("gateway.auth.token")).toBe(false);
  });

  it("treats a byte-identical explicit token override as operator-owned", async () => {
    const config = gatewayAuthConfig({ mode: "token", token: "${LITERAL_TOKEN}" });
    setConfigResolutionFacts(config, new Set(["gateway.auth.token"]));

    await expectResolvedToken({
      cfg: config,
      env: emptyEnv(),
      authOverride: { token: "${LITERAL_TOKEN}" },
      expectedToken: "${LITERAL_TOKEN}",
    });
  });

  it("uses the gateway token environment fallback for an unresolved configured token", async () => {
    const config = gatewayAuthConfig({ mode: "token", token: "${MISSING_TOKEN}" });
    setConfigResolutionFacts(config, new Set(["gateway.auth.token"]));

    await expectResolvedToken({
      cfg: config,
      env: { OPENCLAW_GATEWAY_TOKEN: "environment-token" },
      expectedToken: "environment-token",
    });
  });

  it("ignores an unresolved inactive password in token mode", async () => {
    const config = gatewayAuthConfig({
      mode: "token",
      token: "configured-token",
      password: "${MISSING_PASSWORD}",
    });
    setConfigResolutionFacts(config, new Set(["gateway.auth.password"]));

    await expectResolvedToken({
      cfg: config,
      env: emptyEnv(),
      expectedToken: "configured-token",
    });
  });

  it("does not generate in password mode", async () => {
    await expectNoTokenGeneration(gatewayAuthConfig({ mode: "password" }), "password");
  });

  it("resolves env-template gateway.auth.token before env-token short-circuiting", async () => {
    await expectResolvedToken({
      cfg: gatewayAuthConfig({ mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" }),
      env: {
        OPENCLAW_GATEWAY_TOKEN: "resolved-token",
      } as NodeJS.ProcessEnv,
      expectedToken: "resolved-token",
      expectedConfiguredToken: "${OPENCLAW_GATEWAY_TOKEN}",
    });
  });

  it("keeps configured token SecretRef ahead of OPENCLAW_GATEWAY_TOKEN", async () => {
    const configuredToken = gatewayEnvSecretRef("GW_TOKEN");
    await expectResolvedToken({
      cfg: gatewayAuthConfigWithDefaultEnvProvider({
        mode: "token",
        token: configuredToken,
      }),
      env: {
        GW_TOKEN: "token-from-config-ref",
        OPENCLAW_GATEWAY_TOKEN: "token-from-env",
      } as NodeJS.ProcessEnv,
      expectedToken: "token-from-config-ref",
      expectedConfiguredToken: configuredToken,
    });
  });

  it("does not let OPENCLAW_GATEWAY_TOKEN mask an unresolved configured token ref", async () => {
    await expect(
      runStartupAuth({
        cfg: createMissingGatewayTokenSecretRefConfig(),
        env: { OPENCLAW_GATEWAY_TOKEN: "token-from-env" } as NodeJS.ProcessEnv,
        persist: true,
      }),
    ).rejects.toThrow(/MISSING_GW_TOKEN/i);
  });

  it("fails when gateway.auth.token SecretRef is active and unresolved", async () => {
    await expect(
      runStartupAuth({
        cfg: createMissingGatewayTokenSecretRefConfig(),
        persist: true,
      }),
    ).rejects.toThrow(/MISSING_GW_TOKEN/i);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("requires explicit gateway.auth.mode when token and password are both configured", async () => {
    await expect(
      runStartupAuth({
        cfg: gatewayAuthConfig({
          token: "configured-token",
          password: "configured-password", // pragma: allowlist secret
        }),
        persist: true,
      }),
    ).rejects.toThrow(/gateway\.auth\.mode is unset/i);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("keeps configured password SecretRef ahead of OPENCLAW_GATEWAY_PASSWORD", async () => {
    const configuredPassword = gatewayEnvSecretRef("GW_PASSWORD");
    const result = await runStartupAuth({
      cfg: gatewayAuthConfigWithDefaultEnvProvider({
        mode: "password",
        password: configuredPassword,
      }),
      env: {
        GW_PASSWORD: "password-from-config-ref", // pragma: allowlist secret
        OPENCLAW_GATEWAY_PASSWORD: "password-from-env", // pragma: allowlist secret
      } as NodeJS.ProcessEnv,
      persist: true,
    });

    expectResolvedPassword(result, "password-from-config-ref");
    expect(result.cfg.gateway?.auth?.password).toEqual(configuredPassword);
  });

  it("does not let OPENCLAW_GATEWAY_PASSWORD mask an unresolved configured password ref", async () => {
    await expect(
      runStartupAuth({
        cfg: gatewayAuthConfigWithDefaultEnvProvider({
          mode: "password",
          password: gatewayEnvSecretRef("MISSING_GW_PASSWORD"),
        }),
        env: { OPENCLAW_GATEWAY_PASSWORD: "password-from-env" } as NodeJS.ProcessEnv,
        persist: true,
      }),
    ).rejects.toThrow(/MISSING_GW_PASSWORD/i);
  });

  it("does not resolve gateway.auth.password SecretRef when token mode is explicit", async () => {
    const cfg = gatewayAuthConfigWithDefaultEnvProvider({
      mode: "token",
      token: "configured-token",
      password: { source: "env", provider: "missing", id: "GW_PASSWORD" },
    });

    await expectResolvedToken({
      cfg,
      env: emptyEnv(),
      expectedToken: "configured-token",
    });
  });

  it("does not generate in trusted-proxy mode", async () => {
    await expectNoTokenGeneration(
      {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: { userHeader: "x-forwarded-user" },
          },
        },
      },
      "trusted-proxy",
    );
  });

  it("does not generate in explicit none mode", async () => {
    await expectNoTokenGeneration(
      {
        gateway: {
          auth: {
            mode: "none",
          },
        },
      },
      "none",
    );
  });

  it("preserves an unresolved token fact when an override value is undefined", () => {
    const config = gatewayAuthConfig({ mode: "token", token: "${MISSING_TOKEN}" });
    setConfigResolutionFacts(config, new Set(["gateway.auth.token"]));

    const next = applyGatewayAuthOverridesForStartupPreflight(config, {
      auth: { token: undefined },
    });

    expect(getConfigResolutionFacts(next)?.has("gateway.auth.token")).toBe(true);
  });

  it("treats undefined token override as no override", async () => {
    await expectResolvedToken({
      cfg: {
        gateway: {
          auth: {
            mode: "token",
            token: "from-config",
          },
        },
      },
      env: emptyEnv(),
      authOverride: { mode: "token", token: undefined },
      expectedToken: "from-config",
    });
  });

  it("keeps generated token ephemeral when runtime override flips explicit non-token mode", async () => {
    await expectEphemeralGeneratedTokenWhenOverridden({
      gateway: {
        auth: {
          mode: "password",
        },
      },
    });
  });

  it("keeps generated token ephemeral when runtime override flips explicit none mode", async () => {
    await expectEphemeralGeneratedTokenWhenOverridden({
      gateway: {
        auth: {
          mode: "none",
        },
      },
    });
  });

  it("keeps generated token ephemeral when runtime override flips implicit password mode", async () => {
    await expectEphemeralGeneratedTokenWhenOverridden({
      gateway: {
        auth: {
          password: "configured-password", // pragma: allowlist secret
        },
      },
    });
  });

  it("keeps startup non-breaking when hooks token reuses gateway token resolved from env", async () => {
    const warn = vi.fn();
    const result = await runStartupAuth({
      cfg: {
        hooks: {
          enabled: true,
          token: "shared-gateway-token-1234567890",
        },
      },
      env: {
        OPENCLAW_GATEWAY_TOKEN: "shared-gateway-token-1234567890",
      } as NodeJS.ProcessEnv,
      warn,
    });

    expectNoGeneratedToken(result);
    expect(result.auth.mode).toBe("token");
    expect(result.auth.token).toBe("shared-gateway-token-1234567890");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Security warning"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("openclaw security audit"));
  });

  it("keeps startup non-breaking when hooks token reuses gateway password auth", async () => {
    const warn = vi.fn();
    const result = await runStartupAuth({
      cfg: {
        hooks: {
          enabled: true,
          token: "shared-gateway-password-1234567890",
        },
        gateway: {
          auth: {
            mode: "password",
            password: "shared-gateway-password-1234567890", // pragma: allowlist secret
          },
        },
      },
      warn,
    });

    expectResolvedPassword(result, "shared-gateway-password-1234567890");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Security warning"));
  });

  it("allows distinct hooks token with gateway password auth during startup", async () => {
    const warn = vi.fn();
    const result = await runStartupAuth({
      cfg: {
        hooks: {
          enabled: true,
          token: "distinct-hooks-token-1234567890",
        },
        gateway: {
          auth: {
            mode: "password",
            password: "shared-gateway-password-1234567890", // pragma: allowlist secret
          },
        },
      },
      warn,
    });

    expect(result.auth.mode).toBe("password");
    expectNoGeneratedToken(result);
    expect(warn).not.toHaveBeenCalled();
  });

  it("rejects a published placeholder token supplied via environment", async () => {
    await expect(
      runStartupAuth({
        cfg: {},
        env: { OPENCLAW_GATEWAY_TOKEN: KNOWN_WEAK_GATEWAY_TOKEN_PLACEHOLDERS[0] },
      }),
    ).rejects.toThrow(/example placeholder/i);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it.each([...KNOWN_WEAK_GATEWAY_TOKEN_PLACEHOLDERS, "  change-me-now  "])(
    "rejects the published placeholder token %s supplied via config",
    async (token) => {
      await expect(
        runStartupAuth({
          cfg: gatewayAuthConfig({ mode: "token", token }),
        }),
      ).rejects.toThrow(/example placeholder/i);
      expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    },
  );

  it("rejects the .env.example placeholder password supplied via config", async () => {
    await expect(
      runStartupAuth({
        cfg: gatewayAuthConfig({
          mode: "password",
          password: "change-me-to-a-strong-password", // pragma: allowlist secret
        }),
      }),
    ).rejects.toThrow(/example placeholder/i);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it.each(["  undefined  ", "  "])(
    "rejects invalid password %j with password-specific recovery advice",
    async (password) => {
      await expect(
        runStartupAuth({ cfg: gatewayAuthConfig({ mode: "password", password }), env: emptyEnv() }),
      ).rejects.toThrow(
        /gateway auth password.*Generate a real secret.*OPENCLAW_GATEWAY_PASSWORD.*gateway.auth.password/,
      );
      expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    },
  );

  it.each(["", "  "])(
    "rejects persisted blank token %j instead of generating an ephemeral replacement",
    async (token) => {
      await expect(
        runStartupAuth({ cfg: gatewayAuthConfig({ mode: "token", token }), env: emptyEnv() }),
      ).rejects.toThrow(/blank/);
      expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    },
  );
});
