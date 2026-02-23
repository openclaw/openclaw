import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { expectGeneratedTokenPersistedToGatewayAuth } from "../test-utils/auth-token-assertions.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn<() => OpenClawConfig>(),
  writeConfigFile: vi.fn(async (_cfg: OpenClawConfig) => {}),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: mocks.loadConfig,
    writeConfigFile: mocks.writeConfigFile,
  };
});

import { ensureBrowserControlAuth } from "./control-auth.js";

describe("ensureBrowserControlAuth", () => {
  const expectExplicitModeSkipsAutoAuth = async (mode: "password" | "none") => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: { mode },
      },
      browser: {
        enabled: true,
      },
    };

    const result = await ensureBrowserControlAuth({ cfg, env: {} as NodeJS.ProcessEnv });
    expect(result).toEqual({ auth: {} });
    expect(mocks.loadConfig).not.toHaveBeenCalled();
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  };

  const expectGeneratedTokenPersisted = (result: {
    generatedToken?: string;
    auth: { token?: string };
  }) => {
    expect(mocks.writeConfigFile).toHaveBeenCalledTimes(1);
    expectGeneratedTokenPersistedToGatewayAuth({
      generatedToken: result.generatedToken,
      authToken: result.auth.token,
      persistedConfig: mocks.writeConfigFile.mock.calls[0]?.[0],
    });
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.loadConfig.mockClear();
    mocks.writeConfigFile.mockClear();
  });

  it("returns existing auth and skips writes", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          token: "already-set",
        },
      },
    };

    const result = await ensureBrowserControlAuth({ cfg, env: {} as NodeJS.ProcessEnv });

    expect(result).toEqual({ auth: { token: "already-set" } });
    expect(mocks.loadConfig).not.toHaveBeenCalled();
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("auto-generates and persists a token when auth is missing", async () => {
    const cfg: OpenClawConfig = {
      browser: {
        enabled: true,
      },
    };
    mocks.loadConfig.mockReturnValue({
      browser: {
        enabled: true,
      },
    });

    const result = await ensureBrowserControlAuth({ cfg, env: {} as NodeJS.ProcessEnv });
    expectGeneratedTokenPersisted(result);
  });

  it("skips auto-generation in test env", async () => {
    const cfg: OpenClawConfig = {
      browser: {
        enabled: true,
      },
    };

    const result = await ensureBrowserControlAuth({
      cfg,
      env: { NODE_ENV: "test" } as NodeJS.ProcessEnv,
    });

    expect(result).toEqual({ auth: {} });
    expect(mocks.loadConfig).not.toHaveBeenCalled();
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("respects explicit password mode", async () => {
    await expectExplicitModeSkipsAutoAuth("password");
  });

  it("respects explicit none mode", async () => {
    await expectExplicitModeSkipsAutoAuth("none");
  });

  it("reuses auth from latest config snapshot", async () => {
    const cfg: OpenClawConfig = {
      browser: {
        enabled: true,
      },
    };
    mocks.loadConfig.mockReturnValue({
      gateway: {
        auth: {
          token: "latest-token",
        },
      },
      browser: {
        enabled: true,
      },
    });

    const result = await ensureBrowserControlAuth({ cfg, env: {} as NodeJS.ProcessEnv });

    expect(result).toEqual({ auth: { token: "latest-token" } });
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });
});
