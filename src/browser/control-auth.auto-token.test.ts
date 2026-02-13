import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

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
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.loadConfig.mockReset();
    mocks.writeConfigFile.mockReset();
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

    expect(result.generatedToken).toMatch(/^[0-9a-f]{48}$/);
    expect(result.auth.token).toBe(result.generatedToken);
    expect(mocks.writeConfigFile).toHaveBeenCalledTimes(1);
    const persisted = mocks.writeConfigFile.mock.calls[0]?.[0];
    expect(persisted?.gateway?.auth?.mode).toBe("token");
    expect(persisted?.gateway?.auth?.token).toBe(result.generatedToken);
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
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "password",
        },
      },
      browser: {
        enabled: true,
      },
    };

    const result = await ensureBrowserControlAuth({ cfg, env: {} as NodeJS.ProcessEnv });

    expect(result).toEqual({ auth: {} });
    expect(mocks.loadConfig).not.toHaveBeenCalled();
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
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
