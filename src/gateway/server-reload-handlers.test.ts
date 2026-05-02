import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing as embeddedRunTesting,
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
  type EmbeddedPiQueueHandle,
} from "../agents/pi-embedded-runner/runs.js";
import type { ChannelKind } from "./config-reload-plan.js";
import type { GatewayPluginReloadResult } from "./server-reload-handlers.js";
import { __testing, createGatewayReloadHandlers } from "./server-reload-handlers.js";

describe("gateway reload recovery handlers", () => {
  afterEach(() => {
    embeddedRunTesting.resetActiveEmbeddedRuns();
  });

  it("aborts active agent runs after last-known-good config recovery", () => {
    const sessionId = "config-recovery-session";
    const sessionKey = "agent:main:telegram:direct:123";
    let handle!: EmbeddedPiQueueHandle;
    handle = {
      abort: vi.fn(() => {
        clearActiveEmbeddedRun(sessionId, handle, sessionKey);
      }),
      isCompacting: () => false,
      isStreaming: () => false,
      queueMessage: async () => {},
    };
    const logReload = { info: vi.fn(), warn: vi.fn() };
    setActiveEmbeddedRun(sessionId, handle, sessionKey);

    __testing.abortActiveAgentRunsAfterConfigRecovery({
      reason: "invalid-config",
      logReload,
    });

    expect(handle.abort).toHaveBeenCalledOnce();
    expect(logReload.warn).toHaveBeenCalledWith(
      "config recovery aborted active agent run(s) after reload-invalid-config",
    );
  });

  it("does not warn when config recovery has no active agent runs to abort", () => {
    const logReload = { info: vi.fn(), warn: vi.fn() };

    __testing.abortActiveAgentRunsAfterConfigRecovery({
      reason: "invalid-config",
      logReload,
    });

    expect(logReload.warn).not.toHaveBeenCalled();
  });
});

describe("gateway plugin hot reload handlers", () => {
  it("stops removed channel plugins from broad activation before swapping plugin runtime", async () => {
    const previousSkipChannels = process.env.OPENCLAW_SKIP_CHANNELS;
    const previousSkipProviders = process.env.OPENCLAW_SKIP_PROVIDERS;
    delete process.env.OPENCLAW_SKIP_CHANNELS;
    delete process.env.OPENCLAW_SKIP_PROVIDERS;
    const cron = { start: vi.fn(async () => {}), stop: vi.fn() };
    const heartbeatRunner = {
      stop: vi.fn(),
      updateConfig: vi.fn(),
    };
    const setState = vi.fn();
    const startChannel = vi.fn(async () => {});
    const events: string[] = [];
    const stopChannel = vi.fn(async () => {
      events.push("stop");
    });
    const reloadPlugins = vi.fn(
      async (params: {
        beforeReplace: (channels: ReadonlySet<ChannelKind>) => Promise<void>;
      }): Promise<GatewayPluginReloadResult> => {
        events.push("reload:start");
        await params.beforeReplace(new Set(["discord"]));
        events.push("registry:replace");
        return {
          restartChannels: new Set(),
          activeChannels: new Set(),
        };
      },
    );
    const { applyHotReload } = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => ({
        hooksConfig: {} as never,
        hookClientIpConfig: {} as never,
        heartbeatRunner: heartbeatRunner as never,
        cronState: { cron, storePath: "/tmp/cron.json", cronEnabled: false } as never,
        channelHealthMonitor: null,
      }),
      setState,
      startChannel,
      stopChannel,
      reloadPlugins,
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn() },
      createHealthMonitor: () => null,
    });

    try {
      await applyHotReload(
        {
          changedPaths: ["plugins.enabled"],
          restartGateway: false,
          restartReasons: [],
          hotReasons: ["plugins.enabled"],
          reloadHooks: false,
          restartGmailWatcher: false,
          restartCron: false,
          restartHeartbeat: false,
          restartHealthMonitor: false,
          reloadPlugins: true,
          restartChannels: new Set(),
          disposeMcpRuntimes: false,
          noopPaths: [],
        },
        {
          plugins: {
            enabled: false,
          },
        },
      );
    } finally {
      if (previousSkipChannels === undefined) {
        delete process.env.OPENCLAW_SKIP_CHANNELS;
      } else {
        process.env.OPENCLAW_SKIP_CHANNELS = previousSkipChannels;
      }
      if (previousSkipProviders === undefined) {
        delete process.env.OPENCLAW_SKIP_PROVIDERS;
      } else {
        process.env.OPENCLAW_SKIP_PROVIDERS = previousSkipProviders;
      }
    }

    expect(reloadPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        nextConfig: {
          plugins: {
            enabled: false,
          },
        },
        changedPaths: ["plugins.enabled"],
      }),
    );
    expect(stopChannel).toHaveBeenCalledWith("discord");
    expect(startChannel).not.toHaveBeenCalled();
    expect(events).toEqual(["reload:start", "stop", "registry:replace"]);
    expect(setState).toHaveBeenCalledTimes(1);
  });
});
