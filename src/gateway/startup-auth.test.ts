import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { REDACTED_SENTINEL } from "../config/redact-sentinel.js";
import { getConfigResolutionFacts, setConfigResolutionFacts } from "../config/resolution-facts.js";
import { applyGatewayAuthOverridesForStartupPreflight } from "./server-startup-config-helpers.js";
import { ensureGatewayStartupAuth, mergeGatewayTailscaleConfig } from "./startup-auth.js";

const WEAK_TOKEN = "change-me-to-a-long-random-token";

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

function gatewayEnvSecretRef(id: string) {
  return { source: "env" as const, provider: "default", id };
}

function gatewayAuthConfig(auth: GatewayAuthConfig): OpenClawConfig {
  return { gateway: { auth } };
}

function gatewayAuthConfigWithDefaultEnvProvider(auth: GatewayAuthConfig): OpenClawConfig {
  return {
    ...gatewayAuthConfig(auth),
    secrets: { providers: { default: { source: "env" } } },
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
      expectNoGeneratedToken(result);
      expect(result.auth.mode).toBe("trusted-proxy");
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
    return ensureGatewayStartupAuth({ env: {}, ...params });
  }

  function expectNoGeneratedToken(result: StartupAuthResult) {
    expect(result.generatedToken).toBeUndefined();
    expect(result.persistedGeneratedToken).toBe(false);
  }

  function expectEphemeralGeneratedToken(result: StartupAuthResult) {
    expect(result.generatedToken).toMatch(/^[0-9a-f]{48}$/);
    expect(result).toMatchObject({
      persistedGeneratedToken: false,
      auth: { mode: "token", token: result.generatedToken },
    });
  }

  function expectResolvedPassword(result: StartupAuthResult, password: string) {
    expectNoGeneratedToken(result);
    expect(result.auth).toMatchObject({ mode: "password", password });
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.replaceConfigFile.mockClear();
  });

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
    expect(result.auth).toMatchObject({ mode: "token", token: params.expectedToken });
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

  async function expectAuthFailure(
    auth: GatewayAuthConfig,
    error: RegExp,
    env: NodeJS.ProcessEnv = {},
  ) {
    await expect(runStartupAuth({ cfg: gatewayAuthConfig(auth), env })).rejects.toThrow(error);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
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

    const result = await runStartupAuth({ cfg: config });

    expectEphemeralGeneratedToken(result);
    expect(getConfigResolutionFacts(result.cfg)?.has("gateway.auth.token")).toBe(false);
  });

  it("treats a byte-identical explicit token override as operator-owned", async () => {
    const config = gatewayAuthConfig({ mode: "token", token: "${LITERAL_TOKEN}" });
    setConfigResolutionFacts(config, new Set(["gateway.auth.token"]));

    await expectResolvedToken({
      cfg: config,
      env: {},
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
      env: {},
      expectedToken: "configured-token",
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
      },
      expectedToken: "token-from-config-ref",
      expectedConfiguredToken: configuredToken,
    });
  });

  it("does not let OPENCLAW_GATEWAY_TOKEN mask an unresolved configured token ref", async () => {
    await expect(
      runStartupAuth({
        cfg: createMissingGatewayTokenSecretRefConfig(),
        env: { OPENCLAW_GATEWAY_TOKEN: "token-from-env" },
        persist: true,
      }),
    ).rejects.toThrow(/MISSING_GW_TOKEN/i);
  });

  it("requires explicit gateway.auth.mode when token and password are both configured", async () => {
    await expect(
      runStartupAuth({
        cfg: gatewayAuthConfig({ token: "configured-token", password: "configured-password" }), // pragma: allowlist secret
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
      },
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
        env: { OPENCLAW_GATEWAY_PASSWORD: "password-from-env" },
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
      env: {},
      expectedToken: "configured-token",
    });
  });

  it("does not generate in explicit none mode", async () => {
    const result = await runStartupAuth({
      cfg: gatewayAuthConfig({ mode: "none" }),
      persist: true,
    });
    expectNoGeneratedToken(result);
    expect(result.auth.mode).toBe("none");
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("preserves an unresolved token fact when an override value is undefined", () => {
    const config = gatewayAuthConfig({ mode: "token", token: "${MISSING_TOKEN}" });
    setConfigResolutionFacts(config, new Set(["gateway.auth.token"]));

    const next = applyGatewayAuthOverridesForStartupPreflight(config, {
      auth: { token: undefined },
    });

    expect(getConfigResolutionFacts(next)?.has("gateway.auth.token")).toBe(true);
  });

  it("keeps generated token ephemeral when runtime override flips explicit non-token mode", async () => {
    const result = await runStartupAuth({
      cfg: gatewayAuthConfig({ mode: "password" }),
      authOverride: { mode: "token" },
      persist: true,
    });
    expectEphemeralGeneratedToken(result);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
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
      },
      warn,
    });

    expectNoGeneratedToken(result);
    expect(result.auth).toMatchObject({ mode: "token", token: "shared-gateway-token-1234567890" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Security warning"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("openclaw security audit"));
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
        env: { OPENCLAW_GATEWAY_TOKEN: WEAK_TOKEN },
      }),
    ).rejects.toThrow(/example placeholder/i);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it.each([WEAK_TOKEN, "undefined"])(
    "rejects the published placeholder token %s supplied via config",
    async (token) => {
      await expectAuthFailure({ mode: "token", token }, /example placeholder/i);
    },
  );

  it("rejects the .env.example placeholder password supplied via config", async () => {
    await expectAuthFailure(
      { mode: "password", password: "change-me-to-a-strong-password" }, // pragma: allowlist secret
      /example placeholder/i,
    );
  });

  it.each(["  undefined  "])(
    "rejects invalid password %j with password-specific recovery advice",
    async (password) => {
      await expectAuthFailure(
        { mode: "password", password },
        /gateway auth password.*Generate a real secret.*OPENCLAW_GATEWAY_PASSWORD.*gateway.auth.password/,
      );
    },
  );

  it.each([""])(
    "rejects persisted blank token %j instead of generating an ephemeral replacement",
    async (token) => {
      await expectAuthFailure({ mode: "token", token }, /blank/);
    },
  );
});
