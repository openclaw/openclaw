import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { expectGeneratedTokenPersistedToGatewayAuth } from "../test-utils/auth-token-assertions.js";

const mocks = vi.hoisted(() => ({
  writeConfigFile: vi.fn(async (_cfg: OpenClawConfig) => {}),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    writeConfigFile: mocks.writeConfigFile,
  };
});

import {
  assertHooksTokenSeparateFromGatewayAuth,
  ensureGatewayStartupAuth,
} from "./startup-auth.js";

describe("ensureGatewayStartupAuth", () => {
  async function expectEphemeralGeneratedTokenWhenOverridden(cfg: OpenClawConfig) {
    const result = await ensureGatewayStartupAuth({
      cfg,
      env: {} as NodeJS.ProcessEnv,
      authOverride: { mode: "token" },
      persist: true,
    });

    expect(result.generatedToken).toMatch(/^[0-9a-f]{48}$/);
    expect(result.persistedGeneratedToken).toBe(false);
    expect(result.auth.mode).toBe("token");
    expect(result.auth.token).toBe(result.generatedToken);
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.writeConfigFile.mockClear();
  });

  async function expectNoTokenGeneration(cfg: OpenClawConfig, mode: string) {
    const result = await ensureGatewayStartupAuth({
      cfg,
      env: {} as NodeJS.ProcessEnv,
      persist: true,
    });

    expect(result.generatedToken).toBeUndefined();
    expect(result.persistedGeneratedToken).toBe(false);
    expect(result.auth.mode).toBe(mode);
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  }

  it("generates and persists a token when startup auth is missing", async () => {
    const result = await ensureGatewayStartupAuth({
      cfg: {},
      env: {} as NodeJS.ProcessEnv,
      persist: true,
    });

    expect(result.generatedToken).toMatch(/^[0-9a-f]{48}$/);
    expect(result.persistedGeneratedToken).toBe(true);
    expect(result.auth.mode).toBe("token");
    expect(mocks.writeConfigFile).toHaveBeenCalledTimes(1);
    expectGeneratedTokenPersistedToGatewayAuth({
      generatedToken: result.generatedToken,
      authToken: result.auth.token,
      persistedConfig: mocks.writeConfigFile.mock.calls[0]?.[0],
    });
  });

  it("does not generate when token already exists", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: "configured-token",
        },
      },
    };
    const result = await ensureGatewayStartupAuth({
      cfg,
      env: {} as NodeJS.ProcessEnv,
      persist: true,
    });

    expect(result.generatedToken).toBeUndefined();
    expect(result.persistedGeneratedToken).toBe(false);
    expect(result.auth.mode).toBe("token");
    expect(result.auth.token).toBe("configured-token");
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("does not generate in password mode", async () => {
    await expectNoTokenGeneration(
      {
        gateway: {
          auth: {
            mode: "password",
          },
        },
      },
      "password",
    );
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

  it("treats undefined token override as no override", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: "from-config",
        },
      },
    };
    const result = await ensureGatewayStartupAuth({
      cfg,
      env: {} as NodeJS.ProcessEnv,
      authOverride: { mode: "token", token: undefined },
      persist: true,
    });

    expect(result.generatedToken).toBeUndefined();
    expect(result.persistedGeneratedToken).toBe(false);
    expect(result.auth.mode).toBe("token");
    expect(result.auth.token).toBe("from-config");
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
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
          password: "configured-password",
        },
      },
    });
  });

  it("throws when hooks token reuses gateway token resolved from env", async () => {
    await expect(
      ensureGatewayStartupAuth({
        cfg: {
          hooks: {
            enabled: true,
            token: "shared-gateway-token-1234567890",
          },
        },
        env: {
          OPENCLAW_GATEWAY_TOKEN: "shared-gateway-token-1234567890",
        } as NodeJS.ProcessEnv,
      }),
    ).rejects.toThrow(/hooks\.token must not match gateway auth token/i);
  });
});

describe("assertHooksTokenSeparateFromGatewayAuth", () => {
  it("throws when hooks token reuses gateway token auth", () => {
    expect(() =>
      assertHooksTokenSeparateFromGatewayAuth({
        cfg: {
          hooks: {
            enabled: true,
            token: "shared-gateway-token-1234567890",
          },
        },
        auth: {
          mode: "token",
          modeSource: "config",
          token: "shared-gateway-token-1234567890",
          allowTailscale: false,
        },
      }),
    ).toThrow(/hooks\.token must not match gateway auth token/i);
  });

  it("allows hooks token when gateway auth is not token mode", () => {
    expect(() =>
      assertHooksTokenSeparateFromGatewayAuth({
        cfg: {
          hooks: {
            enabled: true,
            token: "shared-gateway-token-1234567890",
          },
        },
        auth: {
          mode: "password",
          modeSource: "config",
          password: "pw",
          allowTailscale: false,
        },
      }),
    ).not.toThrow();
  });

  it("allows matching values when hooks are disabled", () => {
    expect(() =>
      assertHooksTokenSeparateFromGatewayAuth({
        cfg: {
          hooks: {
            enabled: false,
            token: "shared-gateway-token-1234567890",
          },
        },
        auth: {
          mode: "token",
          modeSource: "config",
          token: "shared-gateway-token-1234567890",
          allowTailscale: false,
        },
      }),
    ).not.toThrow();
  });
});
