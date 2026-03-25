import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { GatewayReloadPlan } from "./config-reload.js";

const hoisted = vi.hoisted(() => ({
  applyGatewayLaneConcurrency: vi.fn(),
  resetDirectoryCache: vi.fn(),
  setGatewaySigusr1RestartPolicy: vi.fn(),
}));

vi.mock("../infra/outbound/target-resolver.js", () => ({
  resetDirectoryCache: hoisted.resetDirectoryCache,
}));

vi.mock("../infra/restart.js", () => ({
  deferGatewayRestartUntilIdle: vi.fn(),
  emitGatewayRestart: vi.fn(),
  setGatewaySigusr1RestartPolicy: hoisted.setGatewaySigusr1RestartPolicy,
}));

vi.mock("./server-lanes.js", () => ({
  applyGatewayLaneConcurrency: hoisted.applyGatewayLaneConcurrency,
}));

import { createGatewayReloadHandlers } from "./server-reload-handlers.js";

type HotReloadState = ReturnType<Parameters<typeof createGatewayReloadHandlers>[0]["getState"]>;

describe("createGatewayReloadHandlers", () => {
  beforeEach(() => {
    hoisted.applyGatewayLaneConcurrency.mockClear();
    hoisted.resetDirectoryCache.mockClear();
    hoisted.setGatewaySigusr1RestartPolicy.mockClear();
  });

  it("reapplies shared lane concurrency during hot reload", async () => {
    const heartbeatRunner = { stop: vi.fn(), updateConfig: vi.fn() };
    const cron = { stop: vi.fn() } as unknown as HotReloadState["cronState"]["cron"];
    let state: HotReloadState = {
      hooksConfig: null,
      hookClientIpConfig: { trustedProxies: undefined, allowRealIpFallback: false },
      heartbeatRunner,
      cronState: {
        cron,
        storePath: "/tmp/cron.json",
        cronEnabled: true,
      },
      browserControl: null,
      channelHealthMonitor: null,
    };
    const handlers = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => state,
      setState: (nextState) => {
        state = nextState;
      },
      startChannel: vi.fn(),
      stopChannel: vi.fn(),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logBrowser: { error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn() },
      createHealthMonitor: vi.fn(),
    });
    const plan: GatewayReloadPlan = {
      changedPaths: ["cron.maxConcurrentRuns"],
      restartGateway: false,
      restartReasons: [],
      hotReasons: ["cron.maxConcurrentRuns"],
      reloadHooks: false,
      restartGmailWatcher: false,
      restartBrowserControl: false,
      restartCron: false,
      restartHeartbeat: false,
      restartHealthMonitor: false,
      restartChannels: new Set(),
      noopPaths: [],
    };
    const nextConfig: OpenClawConfig = {
      cron: { maxConcurrentRuns: 3 },
    };

    await handlers.applyHotReload(plan, nextConfig);

    expect(hoisted.resetDirectoryCache).toHaveBeenCalledOnce();
    expect(hoisted.applyGatewayLaneConcurrency).toHaveBeenCalledWith(nextConfig);
  });
});
