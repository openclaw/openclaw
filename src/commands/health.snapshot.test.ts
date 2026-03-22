import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTokenChannelStatusSummary,
  probeTelegram,
  type ChannelPlugin as TelegramChannelPlugin,
} from "../../extensions/telegram/runtime-api.js";
import {
  listTelegramAccountIds,
  resolveTelegramAccount,
} from "../../extensions/telegram/src/accounts.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import type { HealthSummary } from "./health.js";
import { getHealthSnapshot } from "./health.js";

let testConfig: Record<string, unknown> = {};
let testStore: Record<string, { updatedAt?: number }> = {};

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => testConfig,
  };
});

vi.mock("../config/sessions.js", () => ({
  resolveStorePath: () => "/tmp/sessions.json",
  resolveSessionFilePath: vi.fn(() => "/tmp/sessions.json"),
  loadSessionStore: () => testStore,
  saveSessionStore: vi.fn().mockResolvedValue(undefined),
  readSessionUpdatedAt: vi.fn(() => undefined),
  recordSessionMetaFromInbound: vi.fn().mockResolvedValue(undefined),
  updateLastRoute: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../extensions/telegram/src/fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extensions/telegram/src/fetch.js")>();
  return {
    ...actual,
    resolveTelegramFetch: () => fetch,
  };
});

vi.mock("../../extensions/whatsapp/src/auth-store.js", () => ({
  webAuthExists: vi.fn(async () => true),
  getWebAuthAgeMs: vi.fn(() => 1234),
  readWebSelfId: vi.fn(() => ({ e164: null, jid: null })),
  logWebSelfId: vi.fn(),
  logoutWeb: vi.fn(),
}));

function stubTelegramFetchOk(calls: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("/getMe")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: { id: 1, username: "bot" },
          }),
        } as unknown as Response;
      }
      if (url.includes("/getWebhookInfo")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: {
              url: "https://example.com/h",
              has_custom_certificate: false,
            },
          }),
        } as unknown as Response;
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({ ok: false, description: "nope" }),
      } as unknown as Response;
    }),
  );
}

async function runSuccessfulTelegramProbe(
  config: Record<string, unknown>,
  options?: { clearTokenEnv?: boolean },
) {
  testConfig = config;
  testStore = {};
  vi.stubEnv("DISCORD_BOT_TOKEN", "");
  if (options?.clearTokenEnv) {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
  }

  const calls: string[] = [];
  stubTelegramFetchOk(calls);

  const snap = await getHealthSnapshot({ timeoutMs: 25 });
  const telegram = snap.channels.telegram as {
    configured?: boolean;
    probe?: {
      ok?: boolean;
      bot?: { username?: string };
      webhook?: { url?: string };
    };
  };

  return { calls, telegram };
}

const telegramHealthPlugin: Pick<
  TelegramChannelPlugin,
  "id" | "meta" | "capabilities" | "config" | "status"
> = {
  ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
  config: {
    listAccountIds: (cfg) => listTelegramAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveTelegramAccount({ cfg, accountId }),
    isConfigured: (account) => Boolean(account.token?.trim()),
  },
  status: {
    buildChannelSummary: ({ snapshot }) => buildTokenChannelStatusSummary(snapshot),
    probeAccount: async ({ account, timeoutMs }) =>
      await probeTelegram(account.token, timeoutMs, {
        proxyUrl: account.config.proxy,
        network: account.config.network,
        accountId: account.accountId,
      }),
  },
};

describe("getHealthSnapshot", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", plugin: telegramHealthPlugin, source: "test" }]),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("skips telegram probe when not configured", async () => {
    testConfig = { session: { store: "/tmp/x" } };
    testStore = {
      global: { updatedAt: Date.now() },
      unknown: { updatedAt: Date.now() },
      main: { updatedAt: 1000 },
      foo: { updatedAt: 2000 },
    };
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    vi.stubEnv("DISCORD_BOT_TOKEN", "");
    const snap = (await getHealthSnapshot({
      timeoutMs: 10,
    })) satisfies HealthSummary;
    expect(snap.ok).toBe(true);
    const telegram = snap.channels.telegram as {
      configured?: boolean;
      probe?: unknown;
    };
    expect(telegram.configured).toBe(false);
    expect(telegram.probe).toBeUndefined();
    expect(snap.sessions.count).toBe(2);
    expect(snap.sessions.recent[0]?.key).toBe("foo");
  });

  it("probes telegram getMe + webhook info when configured", async () => {
    const { calls, telegram } = await runSuccessfulTelegramProbe({
      channels: { telegram: { botToken: "t-1" } },
    });
    expect(telegram.configured).toBe(true);
    expect(telegram.probe?.ok).toBe(true);
    expect(telegram.probe?.bot?.username).toBe("bot");
    expect(telegram.probe?.webhook?.url).toMatch(/^https:/);
    expect(calls.some((c) => c.includes("/getMe"))).toBe(true);
    expect(calls.some((c) => c.includes("/getWebhookInfo"))).toBe(true);
  });

  it("treats telegram.tokenFile as configured", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-health-"));
    const tokenFile = path.join(tmpDir, "telegram-token");
    fs.writeFileSync(tokenFile, "t-file\n", "utf-8");
    const { calls, telegram } = await runSuccessfulTelegramProbe(
      { channels: { telegram: { tokenFile } } },
      { clearTokenEnv: true },
    );
    expect(telegram.configured).toBe(true);
    expect(telegram.probe?.ok).toBe(true);
    expect(calls.some((c) => c.includes("bott-file/getMe"))).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns a structured telegram probe error when getMe fails", async () => {
    testConfig = { channels: { telegram: { botToken: "bad-token" } } };
    testStore = {};
    vi.stubEnv("DISCORD_BOT_TOKEN", "");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/getMe")) {
          return {
            ok: false,
            status: 401,
            json: async () => ({ ok: false, description: "unauthorized" }),
          } as unknown as Response;
        }
        throw new Error("unexpected");
      }),
    );

    const snap = await getHealthSnapshot({ timeoutMs: 25 });
    const telegram = snap.channels.telegram as {
      configured?: boolean;
      probe?: { ok?: boolean; status?: number; error?: string };
    };
    expect(telegram.configured).toBe(true);
    expect(telegram.probe?.ok).toBe(false);
    expect(telegram.probe?.status).toBe(401);
    expect(telegram.probe?.error).toMatch(/unauthorized/i);
  });

  it("includes runtime channel state when provided by the gateway", async () => {
    testConfig = {
      channels: {
        telegram: { botToken: "t-1" },
      },
    };
    testStore = {};
    vi.stubEnv("DISCORD_BOT_TOKEN", "");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/getMe")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, result: { id: 1, username: "bot" } }),
          } as unknown as Response;
        }
        if (url.includes("/getWebhookInfo")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, result: { url: "https://example.com/h" } }),
          } as unknown as Response;
        }
        return {
          ok: false,
          status: 404,
          json: async () => ({ ok: false, description: "nope" }),
        } as unknown as Response;
      }),
    );

    const snap = await getHealthSnapshot({
      timeoutMs: 25,
      runtimeSnapshot: {
        channels: {
          telegram: {
            accountId: "default",
            running: true,
            connected: true,
            lastConnectedAt: 123,
            lastEventAt: 456,
          },
        },
        channelAccounts: {
          telegram: {
            default: {
              accountId: "default",
              running: true,
              connected: true,
              lastConnectedAt: 123,
              lastEventAt: 456,
            },
          },
        },
      },
    });
    const telegram = snap.channels.telegram as {
      running?: boolean;
      connected?: boolean;
      lastConnectedAt?: number;
      lastEventAt?: number;
    };
    expect(telegram.running).toBe(true);
    expect(telegram.connected).toBe(true);
    expect(telegram.lastConnectedAt).toBe(123);
    expect(telegram.lastEventAt).toBe(456);
  });

  it("captures unexpected probe exceptions as errors", async () => {
    testConfig = { channels: { telegram: { botToken: "t-err" } } };
    testStore = {};
    vi.stubEnv("DISCORD_BOT_TOKEN", "");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const snap = await getHealthSnapshot({ timeoutMs: 25 });
    const telegram = snap.channels.telegram as {
      configured?: boolean;
      probe?: { ok?: boolean; error?: string };
    };
    expect(telegram.configured).toBe(true);
    expect(telegram.probe?.ok).toBe(false);
    expect(telegram.probe?.error).toMatch(/network down/i);
  });

  it("preserves runtime fields when buildChannelSummary omits them", async () => {
    // Stub a plugin whose buildChannelSummary returns only { configured: true } and
    // does NOT forward connected/lastConnectedAt/lastEventAt from the snapshot.
    const stubPlugin = {
      ...createChannelTestPluginBase({
        id: "telegram",
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
          isConfigured: async () => true,
        },
      }),
      status: {
        buildChannelSummary: async () => ({ configured: true }),
      },
    };
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", plugin: stubPlugin, source: "test" }]),
    );
    testConfig = {};
    testStore = {};
    vi.stubEnv("DISCORD_BOT_TOKEN", "");

    const snap = await getHealthSnapshot({
      timeoutMs: 10,
      probe: false,
      runtimeSnapshot: {
        channels: {
          telegram: {
            accountId: "default",
            running: true,
            connected: true,
            lastConnectedAt: 777,
            lastEventAt: 888,
          },
        },
        channelAccounts: {
          telegram: {
            default: {
              accountId: "default",
              running: true,
              connected: true,
              lastConnectedAt: 777,
              lastEventAt: 888,
            },
          },
        },
      },
    });
    const ch = snap.channels.telegram as {
      configured?: boolean;
      running?: boolean;
      connected?: boolean;
      lastConnectedAt?: number;
      lastEventAt?: number;
    };
    // buildChannelSummary returned { configured: true }; runtime fields must be merged in.
    expect(ch.configured).toBe(true);
    expect(ch.connected).toBe(true);
    expect(ch.running).toBe(true);
    expect(ch.lastConnectedAt).toBe(777);
    expect(ch.lastEventAt).toBe(888);
  });

  it("disables heartbeat for agents without heartbeat blocks", async () => {
    testConfig = {
      agents: {
        defaults: {
          heartbeat: {
            every: "30m",
            target: "last",
          },
        },
        list: [
          { id: "main", default: true },
          { id: "ops", heartbeat: { every: "1h", target: "whatsapp" } },
        ],
      },
    };
    testStore = {};

    const snap = await getHealthSnapshot({ timeoutMs: 10, probe: false });
    const byAgent = new Map(snap.agents.map((agent) => [agent.agentId, agent] as const));
    const main = byAgent.get("main");
    const ops = byAgent.get("ops");

    expect(main?.heartbeat.everyMs).toBeNull();
    expect(main?.heartbeat.every).toBe("disabled");
    expect(ops?.heartbeat.everyMs).toBeTruthy();
    expect(ops?.heartbeat.every).toBe("1h");
  });
});
