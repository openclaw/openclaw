import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMainSessionKeyFromConfig } from "../config/sessions.js";
import { drainSystemEvents } from "../infra/system-events.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
  withGatewayServer,
} from "./test-helpers.js";

const hoisted = vi.hoisted(() => {
  const cronInstances: Array<{
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }> = [];

  class CronServiceMock {
    start = vi.fn(async () => {});
    stop = vi.fn();
    constructor() {
      cronInstances.push(this);
    }
  }

  const browserStop = vi.fn(async () => {});
  const startBrowserControlServerIfEnabled = vi.fn(async () => ({
    stop: browserStop,
  }));

  const heartbeatStop = vi.fn();
  const heartbeatUpdateConfig = vi.fn();
  const startHeartbeatRunner = vi.fn(() => ({
    stop: heartbeatStop,
    updateConfig: heartbeatUpdateConfig,
  }));

  const startGmailWatcher = vi.fn(async () => ({ started: true }));
  const stopGmailWatcher = vi.fn(async () => {});

  const providerManager = {
    getRuntimeSnapshot: vi.fn(() => ({
      providers: {
        whatsapp: {
          running: false,
          connected: false,
          reconnectAttempts: 0,
          lastConnectedAt: null,
          lastDisconnect: null,
          lastMessageAt: null,
          lastEventAt: null,
          lastError: null,
        },
        telegram: {
          running: false,
          lastStartAt: null,
          lastStopAt: null,
          lastError: null,
          mode: null,
        },
        discord: {
          running: false,
          lastStartAt: null,
          lastStopAt: null,
          lastError: null,
        },
        slack: {
          running: false,
          lastStartAt: null,
          lastStopAt: null,
          lastError: null,
        },
        signal: {
          running: false,
          lastStartAt: null,
          lastStopAt: null,
          lastError: null,
          baseUrl: null,
        },
        imessage: {
          running: false,
          lastStartAt: null,
          lastStopAt: null,
          lastError: null,
          cliPath: null,
          dbPath: null,
        },
        msteams: {
          running: false,
          lastStartAt: null,
          lastStopAt: null,
          lastError: null,
        },
      },
      providerAccounts: {
        whatsapp: {},
        telegram: {},
        discord: {},
        slack: {},
        signal: {},
        imessage: {},
        msteams: {},
      },
    })),
    startChannels: vi.fn(async () => {}),
    startChannel: vi.fn(async () => {}),
    stopChannel: vi.fn(async () => {}),
    markChannelLoggedOut: vi.fn(),
  };

  const createChannelManager = vi.fn(() => providerManager);

  const reloaderStop = vi.fn(async () => {});
  let onHotReload: ((plan: unknown, nextConfig: unknown) => Promise<void>) | null = null;
  let onRestart: ((plan: unknown, nextConfig: unknown) => void) | null = null;

  const startGatewayConfigReloader = vi.fn(
    (opts: { onHotReload: typeof onHotReload; onRestart: typeof onRestart }) => {
      onHotReload = opts.onHotReload;
      onRestart = opts.onRestart;
      return { stop: reloaderStop };
    },
  );

  return {
    CronService: CronServiceMock,
    cronInstances,
    browserStop,
    startBrowserControlServerIfEnabled,
    heartbeatStop,
    heartbeatUpdateConfig,
    startHeartbeatRunner,
    startGmailWatcher,
    stopGmailWatcher,
    providerManager,
    createChannelManager,
    startGatewayConfigReloader,
    reloaderStop,
    getOnHotReload: () => onHotReload,
    getOnRestart: () => onRestart,
  };
});

vi.mock("../cron/service.js", () => ({
  CronService: hoisted.CronService,
}));

vi.mock("./server-browser.js", () => ({
  startBrowserControlServerIfEnabled: hoisted.startBrowserControlServerIfEnabled,
}));

vi.mock("../infra/heartbeat-runner.js", () => ({
  startHeartbeatRunner: hoisted.startHeartbeatRunner,
}));

vi.mock("../hooks/gmail-watcher.js", () => ({
  startGmailWatcher: hoisted.startGmailWatcher,
  stopGmailWatcher: hoisted.stopGmailWatcher,
}));

vi.mock("./server-channels.js", () => ({
  createChannelManager: hoisted.createChannelManager,
}));

vi.mock("./config-reload.js", () => ({
  startGatewayConfigReloader: hoisted.startGatewayConfigReloader,
}));

installGatewayTestHooks({ scope: "suite" });

describe("gateway hot reload", () => {
  let prevSkipChannels: string | undefined;
  let prevSkipGmail: string | undefined;
  let prevSkipProviders: string | undefined;
  let prevOpenAiApiKey: string | undefined;

  beforeEach(() => {
    prevSkipChannels = process.env.OPENCLAW_SKIP_CHANNELS;
    prevSkipGmail = process.env.OPENCLAW_SKIP_GMAIL_WATCHER;
    prevSkipProviders = process.env.OPENCLAW_SKIP_PROVIDERS;
    prevOpenAiApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENCLAW_SKIP_CHANNELS = "0";
    delete process.env.OPENCLAW_SKIP_GMAIL_WATCHER;
    delete process.env.OPENCLAW_SKIP_PROVIDERS;
  });

  afterEach(() => {
    if (prevSkipChannels === undefined) {
      delete process.env.OPENCLAW_SKIP_CHANNELS;
    } else {
      process.env.OPENCLAW_SKIP_CHANNELS = prevSkipChannels;
    }
    if (prevSkipGmail === undefined) {
      delete process.env.OPENCLAW_SKIP_GMAIL_WATCHER;
    } else {
      process.env.OPENCLAW_SKIP_GMAIL_WATCHER = prevSkipGmail;
    }
    if (prevSkipProviders === undefined) {
      delete process.env.OPENCLAW_SKIP_PROVIDERS;
    } else {
      process.env.OPENCLAW_SKIP_PROVIDERS = prevSkipProviders;
    }
    if (prevOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = prevOpenAiApiKey;
    }
  });

  async function writeEnvRefConfig() {
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!configPath) {
      throw new Error("OPENCLAW_CONFIG_PATH is not set");
    }
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          models: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                apiKey: { source: "env", id: "OPENAI_API_KEY" },
                models: [],
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  it("applies hot reload actions and emits restart signal", async () => {
    await withGatewayServer(async () => {
      const onHotReload = hoisted.getOnHotReload();
      expect(onHotReload).toBeTypeOf("function");

      const nextConfig = {
        hooks: {
          enabled: true,
          token: "secret",
          gmail: { account: "me@example.com" },
        },
        cron: { enabled: true, store: "/tmp/cron.json" },
        agents: { defaults: { heartbeat: { every: "1m" }, maxConcurrent: 2 } },
        browser: { enabled: true },
        web: { enabled: true },
        channels: {
          telegram: { botToken: "token" },
          discord: { token: "token" },
          signal: { account: "+15550000000" },
          imessage: { enabled: true },
        },
      };

      await onHotReload?.(
        {
          changedPaths: [
            "hooks.gmail.account",
            "cron.enabled",
            "agents.defaults.heartbeat.every",
            "browser.enabled",
            "web.enabled",
            "channels.telegram.botToken",
            "channels.discord.token",
            "channels.signal.account",
            "channels.imessage.enabled",
          ],
          restartGateway: false,
          restartReasons: [],
          hotReasons: ["web.enabled"],
          reloadHooks: true,
          restartGmailWatcher: true,
          restartBrowserControl: true,
          restartCron: true,
          restartHeartbeat: true,
          restartChannels: new Set(["whatsapp", "telegram", "discord", "signal", "imessage"]),
          noopPaths: [],
        },
        nextConfig,
      );

      expect(hoisted.stopGmailWatcher).toHaveBeenCalled();
      expect(hoisted.startGmailWatcher).toHaveBeenCalledWith(nextConfig);

      expect(hoisted.browserStop).toHaveBeenCalledTimes(1);
      expect(hoisted.startBrowserControlServerIfEnabled).toHaveBeenCalledTimes(2);

      expect(hoisted.startHeartbeatRunner).toHaveBeenCalledTimes(1);
      expect(hoisted.heartbeatUpdateConfig).toHaveBeenCalledTimes(1);
      expect(hoisted.heartbeatUpdateConfig).toHaveBeenCalledWith(nextConfig);

      expect(hoisted.cronInstances.length).toBe(2);
      expect(hoisted.cronInstances[0].stop).toHaveBeenCalledTimes(1);
      expect(hoisted.cronInstances[1].start).toHaveBeenCalledTimes(1);

      expect(hoisted.providerManager.stopChannel).toHaveBeenCalledTimes(5);
      expect(hoisted.providerManager.startChannel).toHaveBeenCalledTimes(5);
      expect(hoisted.providerManager.stopChannel).toHaveBeenCalledWith("whatsapp");
      expect(hoisted.providerManager.startChannel).toHaveBeenCalledWith("whatsapp");
      expect(hoisted.providerManager.stopChannel).toHaveBeenCalledWith("telegram");
      expect(hoisted.providerManager.startChannel).toHaveBeenCalledWith("telegram");
      expect(hoisted.providerManager.stopChannel).toHaveBeenCalledWith("discord");
      expect(hoisted.providerManager.startChannel).toHaveBeenCalledWith("discord");
      expect(hoisted.providerManager.stopChannel).toHaveBeenCalledWith("signal");
      expect(hoisted.providerManager.startChannel).toHaveBeenCalledWith("signal");
      expect(hoisted.providerManager.stopChannel).toHaveBeenCalledWith("imessage");
      expect(hoisted.providerManager.startChannel).toHaveBeenCalledWith("imessage");

      const onRestart = hoisted.getOnRestart();
      expect(onRestart).toBeTypeOf("function");

      const signalSpy = vi.fn();
      process.once("SIGUSR1", signalSpy);

      const restartResult = onRestart?.(
        {
          changedPaths: ["gateway.port"],
          restartGateway: true,
          restartReasons: ["gateway.port"],
          hotReasons: [],
          reloadHooks: false,
          restartGmailWatcher: false,
          restartBrowserControl: false,
          restartCron: false,
          restartHeartbeat: false,
          restartChannels: new Set(),
          noopPaths: [],
        },
        {},
      );
      await Promise.resolve(restartResult);

      expect(signalSpy).toHaveBeenCalledTimes(1);
    });
  });

  it("fails startup when required secret refs are unresolved", async () => {
    await writeEnvRefConfig();
    delete process.env.OPENAI_API_KEY;
    await expect(withGatewayServer(async () => {})).rejects.toThrow(
      "Startup failed: required secrets are unavailable",
    );
  });

  it("emits one-shot degraded and recovered system events during secret reload transitions", async () => {
    await writeEnvRefConfig();
    process.env.OPENAI_API_KEY = "sk-startup";

    await withGatewayServer(async () => {
      const onHotReload = hoisted.getOnHotReload();
      expect(onHotReload).toBeTypeOf("function");
      const sessionKey = resolveMainSessionKeyFromConfig();
      const plan = {
        changedPaths: ["models.providers.openai.apiKey"],
        restartGateway: false,
        restartReasons: [],
        hotReasons: ["models.providers.openai.apiKey"],
        reloadHooks: false,
        restartGmailWatcher: false,
        restartBrowserControl: false,
        restartCron: false,
        restartHeartbeat: false,
        restartChannels: new Set(),
        noopPaths: [],
      };
      const nextConfig = {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: { source: "env", id: "OPENAI_API_KEY" },
              models: [],
            },
          },
        },
      };

      delete process.env.OPENAI_API_KEY;
      await expect(onHotReload?.(plan, nextConfig)).rejects.toThrow(
        'Environment variable "OPENAI_API_KEY" is missing or empty.',
      );
      const degradedEvents = drainSystemEvents(sessionKey);
      expect(degradedEvents.some((event) => event.includes("[SECRETS_RELOADER_DEGRADED]"))).toBe(
        true,
      );

      await expect(onHotReload?.(plan, nextConfig)).rejects.toThrow(
        'Environment variable "OPENAI_API_KEY" is missing or empty.',
      );
      expect(drainSystemEvents(sessionKey)).toEqual([]);

      process.env.OPENAI_API_KEY = "sk-recovered";
      await expect(onHotReload?.(plan, nextConfig)).resolves.toBeUndefined();
      const recoveredEvents = drainSystemEvents(sessionKey);
      expect(recoveredEvents.some((event) => event.includes("[SECRETS_RELOADER_RECOVERED]"))).toBe(
        true,
      );
    });
  });
});

describe("gateway agents", () => {
  it("lists configured agents via agents.list RPC", async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);
    const res = await rpcReq<{ agents: Array<{ id: string }> }>(ws, "agents.list", {});
    expect(res.ok).toBe(true);
    expect(res.payload?.agents.map((agent) => agent.id)).toContain("main");
    ws.close();
    await server.close();
  });
});
