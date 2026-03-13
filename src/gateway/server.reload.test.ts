import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMainSessionKeyFromConfig } from "../config/sessions.js";
import { drainSystemEvents } from "../infra/system-events.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
  testState,
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
  let prevGeminiApiKey: string | undefined;

  beforeEach(() => {
    prevSkipChannels = process.env.OPENCLAW_SKIP_CHANNELS;
    prevSkipGmail = process.env.OPENCLAW_SKIP_GMAIL_WATCHER;
    prevSkipProviders = process.env.OPENCLAW_SKIP_PROVIDERS;
    prevOpenAiApiKey = process.env.OPENAI_API_KEY;
    prevGeminiApiKey = process.env.GEMINI_API_KEY;
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
    if (prevGeminiApiKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = prevGeminiApiKey;
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
                apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
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

  async function writeTalkApiKeyEnvRefConfig(refId = "TALK_API_KEY_REF") {
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!configPath) {
      throw new Error("OPENCLAW_CONFIG_PATH is not set");
    }
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          talk: {
            apiKey: { source: "env", provider: "default", id: refId },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  async function writeGatewayTraversalExecRefConfig() {
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!configPath) {
      throw new Error("OPENCLAW_CONFIG_PATH is not set");
    }
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          gateway: {
            auth: {
              mode: "token",
              token: { source: "exec", provider: "vault", id: "a/../b" },
            },
          },
          secrets: {
            providers: {
              vault: {
                source: "exec",
                command: process.execPath,
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

  async function writeGatewayTokenExecRefConfig(params: {
    resolverScriptPath: string;
    modePath: string;
    tokenValue: string;
  }) {
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!configPath) {
      throw new Error("OPENCLAW_CONFIG_PATH is not set");
    }
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          gateway: {
            auth: {
              mode: "token",
              token: { source: "exec", provider: "vault", id: "gateway/token" },
            },
          },
          secrets: {
            providers: {
              vault: {
                source: "exec",
                command: process.execPath,
                allowSymlinkCommand: true,
                args: [params.resolverScriptPath, params.modePath, params.tokenValue],
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

  async function writeDisabledSurfaceRefConfig() {
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!configPath) {
      throw new Error("OPENCLAW_CONFIG_PATH is not set");
    }
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          channels: {
            telegram: {
              enabled: false,
              botToken: { source: "env", provider: "default", id: "DISABLED_TELEGRAM_STARTUP_REF" },
            },
          },
          tools: {
            web: {
              search: {
                enabled: false,
                apiKey: {
                  source: "env",
                  provider: "default",
                  id: "DISABLED_WEB_SEARCH_STARTUP_REF",
                },
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

  async function writeGatewayTokenRefConfig() {
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!configPath) {
      throw new Error("OPENCLAW_CONFIG_PATH is not set");
    }
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          secrets: {
            providers: {
              default: { source: "env" },
            },
          },
          gateway: {
            auth: {
              mode: "token",
              token: { source: "env", provider: "default", id: "MISSING_STARTUP_GW_TOKEN" },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  async function writeAuthProfileEnvRefStore() {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("OPENCLAW_STATE_DIR is not set");
    }
    const authStorePath = path.join(stateDir, "agents", "main", "agent", "auth-profiles.json");
    await fs.mkdir(path.dirname(authStorePath), { recursive: true });
    await fs.writeFile(
      authStorePath,
      `${JSON.stringify(
        {
          version: 1,
          profiles: {
            missing: {
              type: "api_key",
              provider: "openai",
              keyRef: { source: "env", provider: "default", id: "MISSING_OPENCLAW_AUTH_REF" },
            },
          },
          selectedProfileId: "missing",
          lastUsedProfileByModel: {},
          usageStats: {},
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  async function writeWebSearchGeminiRefConfig() {
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!configPath) {
      throw new Error("OPENCLAW_CONFIG_PATH is not set");
    }
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          tools: {
            web: {
              search: {
                enabled: true,
                provider: "gemini",
                gemini: {
                  apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY" },
                },
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

  async function removeMainAuthProfileStore() {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      return;
    }
    const authStorePath = path.join(stateDir, "agents", "main", "agent", "auth-profiles.json");
    await fs.rm(authStorePath, { force: true });
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

  it("fails startup when an active exec ref id contains traversal segments", async () => {
    await writeGatewayTraversalExecRefConfig();
    await expect(withGatewayServer(async () => {})).rejects.toThrow(
      /must not include "\." or "\.\." path segments/i,
    );
  });

  it("allows startup when unresolved refs exist only on disabled surfaces", async () => {
    await writeDisabledSurfaceRefConfig();
    delete process.env.DISABLED_TELEGRAM_STARTUP_REF;
    delete process.env.DISABLED_WEB_SEARCH_STARTUP_REF;
    await expect(withGatewayServer(async () => {})).resolves.toBeUndefined();
  });

  it("honors startup auth overrides before secret preflight gating", async () => {
    await writeGatewayTokenRefConfig();
    delete process.env.MISSING_STARTUP_GW_TOKEN;
    await expect(
      withGatewayServer(async () => {}, {
        serverOptions: {
          auth: {
            mode: "password",
            password: "override-password", // pragma: allowlist secret
          },
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("fails startup when auth-profile secret refs are unresolved", async () => {
    await writeAuthProfileEnvRefStore();
    delete process.env.MISSING_OPENCLAW_AUTH_REF;
    try {
      await expect(withGatewayServer(async () => {})).rejects.toThrow(
        'Environment variable "MISSING_OPENCLAW_AUTH_REF" is missing or empty.',
      );
    } finally {
      await removeMainAuthProfileStore();
    }
  });

  it("emits one-shot degraded and recovered system events during secret reload transitions", async () => {
    await writeEnvRefConfig();
    process.env.OPENAI_API_KEY = "sk-startup"; // pragma: allowlist secret

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
              apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
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

      process.env.OPENAI_API_KEY = "sk-recovered"; // pragma: allowlist secret
      await expect(onHotReload?.(plan, nextConfig)).resolves.toBeUndefined();
      const recoveredEvents = drainSystemEvents(sessionKey);
      expect(recoveredEvents.some((event) => event.includes("[SECRETS_RELOADER_RECOVERED]"))).toBe(
        true,
      );
    });
  });

  it("emits one-shot degraded and recovered system events for web search secret reload transitions", async () => {
    await writeWebSearchGeminiRefConfig();
    process.env.GEMINI_API_KEY = "gemini-startup-key"; // pragma: allowlist secret

    await withGatewayServer(async () => {
      const onHotReload = hoisted.getOnHotReload();
      expect(onHotReload).toBeTypeOf("function");
      const sessionKey = resolveMainSessionKeyFromConfig();
      const plan = {
        changedPaths: ["tools.web.search.gemini.apiKey"],
        restartGateway: false,
        restartReasons: [],
        hotReasons: ["tools.web.search.gemini.apiKey"],
        reloadHooks: false,
        restartGmailWatcher: false,
        restartBrowserControl: false,
        restartCron: false,
        restartHeartbeat: false,
        restartChannels: new Set(),
        noopPaths: [],
      };
      const nextConfig = {
        tools: {
          web: {
            search: {
              enabled: true,
              provider: "gemini",
              gemini: {
                apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY" },
              },
            },
          },
        },
      };

      delete process.env.GEMINI_API_KEY;
      await expect(onHotReload?.(plan, nextConfig)).rejects.toThrow(
        "[WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK]",
      );
      const degradedEvents = drainSystemEvents(sessionKey);
      expect(degradedEvents.some((event) => event.includes("[SECRETS_RELOADER_DEGRADED]"))).toBe(
        true,
      );

      await expect(onHotReload?.(plan, nextConfig)).rejects.toThrow(
        "[WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK]",
      );
      expect(drainSystemEvents(sessionKey)).toEqual([]);

      process.env.GEMINI_API_KEY = "gemini-recovered-key"; // pragma: allowlist secret
      await expect(onHotReload?.(plan, nextConfig)).resolves.toBeUndefined();
      const recoveredEvents = drainSystemEvents(sessionKey);
      expect(recoveredEvents.some((event) => event.includes("[SECRETS_RELOADER_RECOVERED]"))).toBe(
        true,
      );
    });
  });

  it("serves secrets.reload immediately after startup without race failures", async () => {
    await writeEnvRefConfig();
    process.env.OPENAI_API_KEY = "sk-startup"; // pragma: allowlist secret
    const { server, ws } = await startServerWithClient();
    try {
      await connectOk(ws);
      const [first, second] = await Promise.all([
        rpcReq<{ warningCount: number }>(ws, "secrets.reload", {}),
        rpcReq<{ warningCount: number }>(ws, "secrets.reload", {}),
      ]);
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
    } finally {
      ws.close();
      await server.close();
    }
  });

  it("keeps last-known-good snapshot active when secrets.reload fails over RPC", async () => {
    const refId = "RUNTIME_LKG_TALK_API_KEY";
    const previousRefValue = process.env[refId];
    process.env[refId] = "talk-key-before-reload-failure"; // pragma: allowlist secret
    await writeTalkApiKeyEnvRefConfig(refId);

    const { server, ws } = await startServerWithClient();
    try {
      await connectOk(ws);
      const preResolve = await rpcReq<{
        assignments?: Array<{ path: string; pathSegments: string[]; value: unknown }>;
      }>(ws, "secrets.resolve", {
        commandName: "runtime-lkg-test",
        targetIds: ["talk.apiKey"],
      });
      expect(preResolve.ok).toBe(true);
      expect(preResolve.payload?.assignments?.[0]?.path).toBe("talk.apiKey");
      expect(preResolve.payload?.assignments?.[0]?.value).toBe("talk-key-before-reload-failure");

      delete process.env[refId];
      const reload = await rpcReq<{ warningCount?: number }>(ws, "secrets.reload", {});
      expect(reload.ok).toBe(false);
      expect(reload.error?.code).toBe("UNAVAILABLE");
      expect(reload.error?.message ?? "").toContain(refId);

      const postResolve = await rpcReq<{
        assignments?: Array<{ path: string; pathSegments: string[]; value: unknown }>;
      }>(ws, "secrets.resolve", {
        commandName: "runtime-lkg-test",
        targetIds: ["talk.apiKey"],
      });
      expect(postResolve.ok).toBe(true);
      expect(postResolve.payload?.assignments?.[0]?.path).toBe("talk.apiKey");
      expect(postResolve.payload?.assignments?.[0]?.value).toBe("talk-key-before-reload-failure");
    } finally {
      if (previousRefValue === undefined) {
        delete process.env[refId];
      } else {
        process.env[refId] = previousRefValue;
      }
      ws.close();
      await server.close();
    }
  });

  it("keeps last-known-good auth snapshot active when gateway auth token exec reload fails", async () => {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("OPENCLAW_STATE_DIR is not set");
    }
    const resolverScriptPath = path.join(stateDir, "gateway-auth-token-resolver.cjs");
    const modePath = path.join(stateDir, "gateway-auth-token-resolver.mode");
    const tokenValue = "gateway-auth-exec-token";
    await fs.mkdir(path.dirname(resolverScriptPath), { recursive: true });
    await fs.writeFile(
      resolverScriptPath,
      `const fs = require("node:fs");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const modePath = process.argv[2];
  const token = process.argv[3];
  const mode = fs.existsSync(modePath) ? fs.readFileSync(modePath, "utf8").trim() : "ok";
  let ids = ["gateway/token"];
  try {
    const parsed = JSON.parse(input || "{}");
    if (Array.isArray(parsed.ids) && parsed.ids.length > 0) {
      ids = parsed.ids.map((entry) => String(entry));
    }
  } catch {}

  if (mode === "fail") {
    const errors = {};
    for (const id of ids) {
      errors[id] = { message: "forced failure" };
    }
    process.stdout.write(JSON.stringify({ protocolVersion: 1, values: {}, errors }) + "\\n");
    return;
  }

  const values = {};
  for (const id of ids) {
    values[id] = token;
  }
  process.stdout.write(JSON.stringify({ protocolVersion: 1, values }) + "\\n");
});
`,
      "utf8",
    );
    await fs.writeFile(modePath, "ok\n", "utf8");
    await writeGatewayTokenExecRefConfig({
      resolverScriptPath,
      modePath,
      tokenValue,
    });

    const previousGatewayAuth = testState.gatewayAuth;
    const previousGatewayTokenEnv = process.env.OPENCLAW_GATEWAY_TOKEN;
    testState.gatewayAuth = undefined;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;

    const started = await startServerWithClient();
    const { server, ws, envSnapshot } = started;
    try {
      await connectOk(ws, {
        token: tokenValue,
      });
      const preResolve = await rpcReq<{
        assignments?: Array<{ path: string; pathSegments: string[]; value: unknown }>;
      }>(ws, "secrets.resolve", {
        commandName: "runtime-lkg-auth-test",
        targetIds: ["gateway.auth.token"],
      });
      expect(preResolve.ok).toBe(true);
      expect(preResolve.payload?.assignments?.[0]?.path).toBe("gateway.auth.token");
      expect(preResolve.payload?.assignments?.[0]?.value).toBe(tokenValue);

      await fs.writeFile(modePath, "fail\n", "utf8");
      const reload = await rpcReq<{ warningCount?: number }>(ws, "secrets.reload", {});
      expect(reload.ok).toBe(false);
      expect(reload.error?.code).toBe("UNAVAILABLE");
      expect(reload.error?.message ?? "").toContain("forced failure");

      const postResolve = await rpcReq<{
        assignments?: Array<{ path: string; pathSegments: string[]; value: unknown }>;
      }>(ws, "secrets.resolve", {
        commandName: "runtime-lkg-auth-test",
        targetIds: ["gateway.auth.token"],
      });
      expect(postResolve.ok).toBe(true);
      expect(postResolve.payload?.assignments?.[0]?.path).toBe("gateway.auth.token");
      expect(postResolve.payload?.assignments?.[0]?.value).toBe(tokenValue);
    } finally {
      testState.gatewayAuth = previousGatewayAuth;
      if (previousGatewayTokenEnv === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = previousGatewayTokenEnv;
      }
      envSnapshot.restore();
      ws.close();
      await server.close();
    }
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
