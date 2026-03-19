import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { expectGeneratedTokenPersistedToGatewayAuth } from "../test-utils/auth-token-assertions.js";

/**
 * Regression test for AA-jtp: gateway.auth.mode=none must NOT propagate to the
 * browser control server.  The browser control surface must always be protected
 * with an auto-generated token even when the gateway intentionally runs without
 * authentication.
 */

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

describe("AA-jtp regression: mode=none must not bypass browser control auth", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.loadConfig.mockClear();
    mocks.writeConfigFile.mockClear();
  });

  it("auto-generates and persists a browser token when gateway mode is none", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: { mode: "none" },
      },
      browser: {
        enabled: true,
      },
    };
    mocks.loadConfig.mockReturnValue(cfg);

    const result = await ensureBrowserControlAuth({ cfg, env: {} as NodeJS.ProcessEnv });

    expect(result.generatedToken).toBeDefined();
    expect(mocks.writeConfigFile).toHaveBeenCalledTimes(1);
    expectGeneratedTokenPersistedToGatewayAuth({
      generatedToken: result.generatedToken,
      authToken: result.auth.token,
      persistedConfig: mocks.writeConfigFile.mock.calls[0]?.[0],
    });
  });

  it("auto-generates token when re-read config still has mode=none", async () => {
    // Initial config has no auth; re-read also returns mode=none.
    const cfg: OpenClawConfig = {
      browser: { enabled: true },
    };
    const latestCfg: OpenClawConfig = {
      gateway: {
        auth: { mode: "none" },
      },
      browser: { enabled: true },
    };
    mocks.loadConfig.mockReturnValue(latestCfg);

    const result = await ensureBrowserControlAuth({ cfg, env: {} as NodeJS.ProcessEnv });

    expect(result.generatedToken).toBeDefined();
    expect(result.auth.token).toBe(result.generatedToken);
    expect(mocks.writeConfigFile).toHaveBeenCalledTimes(1);
  });

  it("browser auth token is a 48-char hex string", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: { mode: "none" },
      },
      browser: { enabled: true },
    };
    mocks.loadConfig.mockReturnValue(cfg);

    const result = await ensureBrowserControlAuth({ cfg, env: {} as NodeJS.ProcessEnv });

    expect(result.generatedToken).toMatch(/^[0-9a-f]{48}$/);
  });

  it("does not skip auto-generation in non-test env with mode=none", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: { mode: "none" },
      },
      browser: { enabled: true },
    };
    mocks.loadConfig.mockReturnValue(cfg);

    // Explicitly verify the production path (no NODE_ENV=test, no VITEST).
    const result = await ensureBrowserControlAuth({
      cfg,
      env: { NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv,
    });

    expect(result.generatedToken).toBeDefined();
    expect(result.auth.token).toBeDefined();
  });
});
