import { describe, expect, it, vi } from "vitest";
import { CONFIG_PATH, type OpenClawConfig } from "../config/config.js";
import type { PreparedSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import type { GatewayReloadPlan } from "./config-reload.js";
import { startGatewayRuntimeConfigReloader } from "./server-config-reloader-runtime.js";

function createPlan(): GatewayReloadPlan {
  return {
    changedPaths: ["gateway.auth"],
    restartGateway: false,
    restartReasons: [],
    hotReasons: [],
    reloadHooks: false,
    restartGmailWatcher: false,
    restartBrowserControl: false,
    restartCron: false,
    restartHeartbeat: false,
    restartHealthMonitor: false,
    restartChannels: new Set(),
    noopPaths: [],
  };
}

function createPreparedSnapshot(config: OpenClawConfig): PreparedSecretsRuntimeSnapshot {
  return {
    sourceConfig: config,
    config,
    authStores: [],
    warnings: [],
    webTools: {
      search: {
        providerSource: "none",
        diagnostics: [],
      },
      fetch: {
        firecrawl: {
          active: false,
          apiKeySource: "missing",
          diagnostics: [],
        },
      },
      diagnostics: [],
    },
  };
}

describe("startGatewayRuntimeConfigReloader", () => {
  it("rolls secrets runtime back to previous snapshot when hot reload fails", async () => {
    const previousSnapshot = createPreparedSnapshot({ gateway: { auth: { mode: "token" } } });
    const nextConfig: OpenClawConfig = { gateway: { auth: { mode: "token", token: "next" } } };
    const preparedNext = createPreparedSnapshot(nextConfig);
    const startGatewayConfigReloaderFn = vi.fn();
    let onHotReload:
      | ((plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => Promise<void>)
      | undefined;
    startGatewayConfigReloaderFn.mockImplementation((opts) => {
      onHotReload = opts.onHotReload;
      return { stop: vi.fn(async () => {}) };
    });
    const secretsRuntime = {
      getActive: vi.fn().mockReturnValue(previousSnapshot),
      activate: vi.fn<(snapshot: PreparedSecretsRuntimeSnapshot) => void>(),
      clear: vi.fn(),
    };

    startGatewayRuntimeConfigReloader({
      initialConfig: {},
      readSnapshot: vi.fn(),
      activateRuntimeSecrets: vi.fn().mockResolvedValue(preparedNext),
      applyHotReload: vi.fn().mockRejectedValue(new Error("apply failed")),
      requestGatewayRestart: vi.fn(),
      secretsRuntime,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      startGatewayConfigReloaderFn,
    });

    await expect(onHotReload?.(createPlan(), nextConfig)).rejects.toThrow("apply failed");
    expect(secretsRuntime.activate).toHaveBeenCalledWith(previousSnapshot);
    expect(secretsRuntime.clear).not.toHaveBeenCalled();
  });

  it("clears secrets runtime when no previous snapshot exists and hot reload fails", async () => {
    const nextConfig: OpenClawConfig = { gateway: { auth: { mode: "token", token: "next" } } };
    const preparedNext = createPreparedSnapshot(nextConfig);
    const startGatewayConfigReloaderFn = vi.fn();
    let onHotReload:
      | ((plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => Promise<void>)
      | undefined;
    startGatewayConfigReloaderFn.mockImplementation((opts) => {
      onHotReload = opts.onHotReload;
      return { stop: vi.fn(async () => {}) };
    });
    const secretsRuntime = {
      getActive: vi.fn().mockReturnValue(null),
      activate: vi.fn<(snapshot: PreparedSecretsRuntimeSnapshot) => void>(),
      clear: vi.fn(),
    };

    startGatewayRuntimeConfigReloader({
      initialConfig: {},
      readSnapshot: vi.fn(),
      activateRuntimeSecrets: vi.fn().mockResolvedValue(preparedNext),
      applyHotReload: vi.fn().mockRejectedValue(new Error("apply failed")),
      requestGatewayRestart: vi.fn(),
      secretsRuntime,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      startGatewayConfigReloaderFn,
    });

    await expect(onHotReload?.(createPlan(), nextConfig)).rejects.toThrow("apply failed");
    expect(secretsRuntime.activate).not.toHaveBeenCalled();
    expect(secretsRuntime.clear).toHaveBeenCalledTimes(1);
  });

  it("runs restart precheck before requesting gateway restart", async () => {
    const plan = createPlan();
    const nextConfig: OpenClawConfig = { gateway: { auth: { mode: "token", token: "next" } } };
    const requestGatewayRestart =
      vi.fn<(plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => void>();
    const activateRuntimeSecrets = vi
      .fn<
        (
          config: OpenClawConfig,
          params: { reason: "reload" | "restart-check"; activate: boolean },
        ) => Promise<PreparedSecretsRuntimeSnapshot>
      >()
      .mockResolvedValue(createPreparedSnapshot(nextConfig));
    const startGatewayConfigReloaderFn = vi.fn();
    let onRestart:
      | ((plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => Promise<void>)
      | undefined;
    startGatewayConfigReloaderFn.mockImplementation((opts) => {
      onRestart = opts.onRestart;
      return { stop: vi.fn(async () => {}) };
    });

    startGatewayRuntimeConfigReloader({
      initialConfig: {},
      readSnapshot: vi.fn(),
      activateRuntimeSecrets,
      applyHotReload: vi.fn(async () => {}),
      requestGatewayRestart,
      secretsRuntime: {
        getActive: vi.fn().mockReturnValue(null),
        activate: vi.fn(),
        clear: vi.fn(),
      },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      startGatewayConfigReloaderFn,
    });

    await onRestart?.(plan, nextConfig);

    expect(activateRuntimeSecrets).toHaveBeenCalledWith(nextConfig, {
      reason: "restart-check",
      activate: false,
    });
    expect(requestGatewayRestart).toHaveBeenCalledWith(plan, nextConfig);
  });

  it("uses CONFIG_PATH when watchPath is not provided", async () => {
    const startGatewayConfigReloaderFn = vi.fn().mockReturnValue({ stop: vi.fn(async () => {}) });

    startGatewayRuntimeConfigReloader({
      initialConfig: {},
      readSnapshot: vi.fn(),
      activateRuntimeSecrets: vi.fn(async (config: OpenClawConfig) =>
        createPreparedSnapshot(config),
      ),
      applyHotReload: vi.fn(async () => {}),
      requestGatewayRestart: vi.fn(),
      secretsRuntime: {
        getActive: vi.fn().mockReturnValue(null),
        activate: vi.fn(),
        clear: vi.fn(),
      },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      startGatewayConfigReloaderFn,
    });

    expect(startGatewayConfigReloaderFn).toHaveBeenCalledWith(
      expect.objectContaining({
        watchPath: CONFIG_PATH,
      }),
    );
  });
});
