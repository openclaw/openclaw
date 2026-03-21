import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { setRegistry } from "./server.agent.gateway-server-agent.mocks.js";
import { createRegistry } from "./server.e2e-registry-helpers.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

let readConfigFileSnapshot: typeof import("../config/config.js").readConfigFileSnapshot;
let writeConfigFile: typeof import("../config/config.js").writeConfigFile;

installGatewayTestHooks({ scope: "suite" });

const createStubChannelPlugin = (params: {
  id: ChannelPlugin["id"];
  label: string;
  summary?: Record<string, unknown>;
  logoutCleared?: boolean;
}): ChannelPlugin => ({
  ...createChannelTestPluginBase({
    id: params.id,
    label: params.label,
    config: { isConfigured: async () => false },
  }),
  status: {
    buildChannelSummary: async () => ({
      configured: false,
      ...params.summary,
    }),
  },
  gateway: {
    logoutAccount: async () => ({
      cleared: params.logoutCleared ?? false,
      envToken: false,
    }),
  },
});

const telegramPlugin: ChannelPlugin = {
  ...createStubChannelPlugin({
    id: "telegram",
    label: "Telegram",
    summary: { tokenSource: "none", lastProbeAt: null },
    logoutCleared: true,
  }),
  gateway: {
    logoutAccount: async ({ cfg }) => {
      const nextTelegram = cfg.channels?.telegram ? { ...cfg.channels.telegram } : {};
      delete nextTelegram.botToken;
      await writeConfigFile({
        ...cfg,
        channels: {
          ...cfg.channels,
          telegram: nextTelegram,
        },
      });
      return { cleared: true, envToken: false, loggedOut: true };
    },
  },
};

const defaultRegistry = createRegistry([
  {
    pluginId: "whatsapp",
    source: "test",
    plugin: createStubChannelPlugin({ id: "whatsapp", label: "WhatsApp" }),
  },
  {
    pluginId: "telegram",
    source: "test",
    plugin: telegramPlugin,
  },
  {
    pluginId: "signal",
    source: "test",
    plugin: createStubChannelPlugin({
      id: "signal",
      label: "Signal",
      summary: { lastProbeAt: null },
    }),
  },
]);

let server: Awaited<ReturnType<typeof startServerWithClient>>["server"];
let ws: Awaited<ReturnType<typeof startServerWithClient>>["ws"];

beforeAll(async () => {
  ({ readConfigFileSnapshot, writeConfigFile } = await import("../config/config.js"));
  setRegistry(defaultRegistry);
  const started = await startServerWithClient();
  server = started.server;
  ws = started.ws;
  await connectOk(ws);
});

afterAll(async () => {
  ws.close();
  await server.close();
});

describe("gateway server channels", () => {
  test("channels.status returns snapshot without probe", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", undefined);
    setRegistry(defaultRegistry);
    const res = await rpcReq<{
      channels?: Record<
        string,
        {
          configured?: boolean;
          tokenSource?: string;
          probe?: unknown;
          lastProbeAt?: unknown;
          linked?: boolean;
        }
      >;
    }>(ws, "channels.status", { probe: false, timeoutMs: 2000 });
    expect(res.ok).toBe(true);
    const telegram = res.payload?.channels?.telegram;
    const signal = res.payload?.channels?.signal;
    expect(res.payload?.channels?.whatsapp).toBeTruthy();
    expect(telegram?.configured).toBe(false);
    expect(telegram?.tokenSource).toBe("none");
    expect(telegram?.probe).toBeUndefined();
    expect(telegram?.lastProbeAt).toBeNull();
    expect(signal?.configured).toBe(false);
    expect(signal?.probe).toBeUndefined();
    expect(signal?.lastProbeAt).toBeNull();
  });

  test("channels.logout reports no session when missing", async () => {
    setRegistry(defaultRegistry);
    const res = await rpcReq<{ cleared?: boolean; channel?: string }>(ws, "channels.logout", {
      channel: "whatsapp",
    });
    expect(res.ok).toBe(true);
    expect(res.payload?.channel).toBe("whatsapp");
    expect(res.payload?.cleared).toBe(false);
  });

  test("channels.logout clears telegram bot token from config", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", undefined);
    setRegistry(defaultRegistry);
    await writeConfigFile({
      channels: {
        telegram: {
          botToken: "123:abc",
          groups: { "*": { requireMention: false } },
        },
      },
    });
    const res = await rpcReq<{
      cleared?: boolean;
      envToken?: boolean;
      channel?: string;
    }>(ws, "channels.logout", { channel: "telegram" });
    expect(res.ok).toBe(true);
    expect(res.payload?.channel).toBe("telegram");
    expect(res.payload?.cleared).toBe(true);
    expect(res.payload?.envToken).toBe(false);

    const snap = await readConfigFileSnapshot();
    expect(snap.valid).toBe(true);
    expect(snap.config?.channels?.telegram?.botToken).toBeUndefined();
    expect(snap.config?.channels?.telegram?.groups?.["*"]?.requireMention).toBe(false);
  });

  test("channels.status probes accounts in parallel and degrades probe failures per account", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const slowPlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "telegram",
        label: "Telegram",
        config: {
          listAccountIds: () => ["default", "ops"],
          defaultAccountId: () => "default",
          resolveAccount: (_cfg, accountId) => ({ accountId }),
          isConfigured: async () => true,
          isEnabled: () => true,
        },
      }),
      status: {
        buildChannelSummary: async () => ({ configured: true }),
        probeAccount: async ({ account }) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 25));
          inFlight -= 1;
          const accountId =
            typeof account === "object" && account && "accountId" in account
              ? String((account as { accountId: string }).accountId)
              : "default";
          if (accountId === "ops") {
            await new Promise((resolve) => setTimeout(resolve, 1_100));
          }
          return { ok: true, bot: { username: `${accountId}_bot` } };
        },
      },
    };

    setRegistry(
      createRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: slowPlugin,
        },
      ]),
    );

    const res = await rpcReq<{
      channelAccounts?: Record<
        string,
        Array<{ accountId?: string; probe?: { ok?: boolean; error?: string } }>
      >;
    }>(ws, "channels.status", { probe: true, timeoutMs: 1_000 });

    expect(res.ok).toBe(true);
    expect(maxInFlight).toBeGreaterThan(1);
    const telegramAccounts = res.payload?.channelAccounts?.telegram ?? [];
    expect(telegramAccounts).toHaveLength(2);
    expect(
      telegramAccounts.find((account) => account.accountId === "default")?.probe,
    ).toMatchObject({
      ok: true,
    });
    expect(telegramAccounts.find((account) => account.accountId === "ops")?.probe).toMatchObject({
      ok: false,
      error: "telegram:ops probe timed out after 1000ms",
    });
  });
});
