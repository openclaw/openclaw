import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ChannelAccountSnapshot } from "../channels/plugins/types.public.js";
import type { HealthSummary } from "../gateway/health/types.js";
import {
  loadFreshHealthModulesForTest,
  type HealthTestPlugin,
  type LegacyHealthSnapshotParams,
} from "./health.snapshot.test-support.js";
import { channelRuntime } from "./health.test-fixtures.js";

let testConfig: Record<string, unknown> = {};
let healthPluginsForTest: HealthTestPlugin[] = [];
const tempDirs = createTempDirTracker();
let sessionStorePath: string;

let setActivePluginRegistry: typeof import("../plugins/runtime.js").setActivePluginRegistry;
let setActiveDegradedPlugins: typeof import("../plugins/runtime-degraded-state.js").setActiveDegradedPlugins;
let createChannelTestPluginBase: typeof import("../test-utils/channel-plugins.js").createChannelTestPluginBase;
let createTestRegistry: typeof import("../test-utils/channel-plugins.js").createTestRegistry;
let getHealthSnapshot: (params?: LegacyHealthSnapshotParams) => Promise<HealthSummary>;
let buildTelegramHealthSummaryForTest = buildTelegramHealthSummary;
let probeTelegramAccountForTestOverride:
  | ((account: TelegramHealthAccount, timeoutMs: number) => Promise<Record<string, unknown>>)
  | undefined;

type TelegramHealthAccount = {
  accountId: string;
  token: string;
  configured: boolean;
};

type DiscordHealthAccount = {
  accountId: string;
  token: string;
  tokenSource: string;
  tokenStatus?: "available" | "configured_unavailable" | "missing";
  enabled: boolean;
  configured: boolean;
};

type AccountParams = { cfg: Record<string, unknown>; accountId?: string | null };
function healthPlugin(
  id: string,
  label: string,
  config: HealthTestPlugin["config"],
  status: HealthTestPlugin["status"],
): HealthTestPlugin {
  return { ...createChannelTestPluginBase({ id, label }), config, status };
}

function telegramAccount(params: AccountParams): TelegramHealthAccount {
  const channels = params.cfg.channels as Record<string, { botToken?: string }> | undefined;
  const accountId = params.accountId?.trim() || "default";
  const token = channels?.telegram?.botToken?.trim() ?? "";
  return { accountId, token, configured: token.length > 0 };
}

function buildTelegramHealthSummary(snapshot: {
  accountId: string;
  configured?: boolean;
  probe?: unknown;
  lastProbeAt?: number | null;
}) {
  const probeRecord =
    snapshot.probe && typeof snapshot.probe === "object"
      ? (snapshot.probe as Record<string, unknown>)
      : null;
  return {
    accountId: snapshot.accountId,
    configured: Boolean(snapshot.configured),
    ...(probeRecord ? { probe: probeRecord } : {}),
    ...(snapshot.lastProbeAt ? { lastProbeAt: snapshot.lastProbeAt } : {}),
  };
}

function createTelegramHealthPlugin(): HealthTestPlugin {
  const resolveAccount: HealthTestPlugin["config"]["resolveAccount"] = (cfg, accountId) =>
    telegramAccount({ cfg: cfg as Record<string, unknown>, accountId });
  return healthPlugin(
    "telegram",
    "Telegram",
    {
      listAccountIds: () => ["default"],
      resolveAccount,
      inspectAccount: resolveAccount,
      isConfigured: (account) => Boolean((account as TelegramHealthAccount).token.trim()),
    },
    {
      buildChannelSummary: ({ snapshot }) => buildTelegramHealthSummaryForTest(snapshot),
      probeAccount: async ({ account, timeoutMs }) =>
        await probeTelegramAccountForTestOverride?.(account as TelegramHealthAccount, timeoutMs),
    },
  );
}

function discordAccount(params: AccountParams, inspect = false): DiscordHealthAccount {
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const discord = (channels?.discord as Record<string, unknown> | undefined) ?? {};
  const accountId = params.accountId?.trim() || "default";
  const token = typeof discord.token === "string" ? discord.token.trim() : "";
  const tokenStatus =
    token.length > 0
      ? "available"
      : inspect && discord.token && typeof discord.token === "object"
        ? "configured_unavailable"
        : "missing";
  return {
    accountId,
    token,
    tokenSource: tokenStatus === "missing" ? "none" : "config",
    ...(inspect || token ? { tokenStatus } : {}),
    enabled: discord.enabled !== false,
    configured: tokenStatus !== "missing",
  };
}

function createDiscordHealthPlugin(): HealthTestPlugin {
  return healthPlugin(
    "discord",
    "Discord",
    {
      listAccountIds: () => ["default"],
      resolveAccount: (cfg, accountId) =>
        discordAccount({ cfg: cfg as Record<string, unknown>, accountId }),
      inspectAccount: (cfg, accountId) =>
        discordAccount({ cfg: cfg as Record<string, unknown>, accountId }, true),
      isEnabled: (account) => (account as DiscordHealthAccount).enabled,
      isConfigured: (account) => (account as DiscordHealthAccount).configured,
    },
    {
      buildAccountSnapshot: ({ account, runtime }) => {
        const resolved = account as DiscordHealthAccount;
        return {
          accountId: resolved.accountId,
          enabled: resolved.enabled,
          configured: resolved.configured,
          tokenSource: resolved.tokenSource,
          tokenStatus: resolved.tokenStatus,
          running: runtime?.running ?? false,
          connected: runtime?.connected ?? false,
          lastConnectedAt: runtime?.lastConnectedAt ?? null,
        } satisfies ChannelAccountSnapshot;
      },
      buildChannelSummary: ({ snapshot }) => ({
        configured: snapshot.configured ?? false,
        tokenSource: snapshot.tokenSource ?? "none",
        tokenStatus: snapshot.tokenStatus,
        running: snapshot.running ?? false,
        connected: snapshot.connected ?? false,
      }),
    },
  );
}

function createIMessageHealthPlugin(): HealthTestPlugin {
  const resolveAccount = (_cfg: unknown, accountId?: string | null) => ({
    accountId: accountId?.trim() || "default",
    enabled: true,
    configured: true,
  });
  return healthPlugin(
    "imessage",
    "iMessage",
    {
      listAccountIds: () => ["default"],
      resolveAccount,
      inspectAccount: resolveAccount,
      isEnabled: (account) => (account as ReturnType<typeof resolveAccount>).enabled,
      isConfigured: (account) => (account as ReturnType<typeof resolveAccount>).configured,
    },
    {
      buildChannelSummary: ({ snapshot }) => ({
        accountId: snapshot.accountId,
        configured: Boolean(snapshot.configured),
        ...(snapshot.probe && typeof snapshot.probe === "object" ? { probe: snapshot.probe } : {}),
      }),
      probeAccount: async () => ({
        ok: false,
        error:
          "imsg cannot access /Users/alice/Library/Messages/chat.db. Grant Full Disk Access to the Gateway/launcher process and restart Gateway. privateApi=/tmp/openclaw/private.sock",
        privateApi: {
          rpcCommand: "imsg rpc --json",
          diagnostics: "sensitive transport details",
        },
      }),
    },
  );
}

describe("collectGatewayHealthSnapshot", () => {
  beforeAll(async () => {
    ({
      setActivePluginRegistry,
      setActiveDegradedPlugins,
      createChannelTestPluginBase,
      createTestRegistry,
      getHealthSnapshot,
    } = await loadFreshHealthModulesForTest({
      getConfig: () => testConfig,
      getSessionStorePath: () => sessionStorePath,
      getSessions: () => ({}),
      getPlugins: () => healthPluginsForTest,
    }));
  });

  beforeEach(() => {
    // Snapshot contents must not depend on host scheduling; deadline tests advance time explicitly.
    vi.useFakeTimers({ toFake: ["Date"] });
    // Session rows are mocked, but the collector still resolves their physical store.
    sessionStorePath = path.join(
      tempDirs.make("openclaw-health-snapshot-sessions-"),
      "sessions.json",
    );
    setActiveDegradedPlugins([]);
    buildTelegramHealthSummaryForTest = buildTelegramHealthSummary;
    probeTelegramAccountForTestOverride = undefined;
    healthPluginsForTest = [createTelegramHealthPlugin()];
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "telegram", plugin: createTelegramHealthPlugin(), source: "test" },
      ]),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    setActivePluginRegistry(createTestRegistry([]));
    tempDirs.cleanup();
  });

  it.each([false, true])(
    "keeps unavailable accounts visible (resolved sibling=%s)",
    async (withSibling) => {
      testConfig = {};
      setActivePluginRegistry(createTestRegistry([]));
      const probeAccount = vi.fn(async () => ({ ok: true }));
      const runtimeOnly = vi.fn(() =>
        expect.unreachable("runtime hook received an inspection summary"),
      );
      const buildAccountSnapshot = vi.fn(({ account }: { account: unknown }) => {
        expect(account).toMatchObject({ token: "healthy-token" });
        return { accountId: "healthy", configured: true, name: "Resolved healthy account" };
      });
      const id = "health-inspection-fixture";
      healthPluginsForTest = [
        healthPlugin(
          id,
          "Inspection",
          {
            listAccountIds: () => (withSibling ? ["default", "healthy"] : ["default"]),
            resolveAccount: (_cfg, accountId) => {
              if (!withSibling || accountId !== "healthy") {
                throw new Error("credential unavailable");
              }
              return { accountId, enabled: true, configured: true, token: "healthy-token" };
            },
            inspectAccount: (_cfg, accountId) =>
              withSibling
                ? {
                    accountId,
                    enabled: true,
                    configured: true,
                    tokenStatus: accountId === "healthy" ? "available" : "configured_unavailable",
                  }
                : undefined,
          },
          withSibling
            ? { probeAccount, buildAccountSnapshot }
            : {
                probeAccount: runtimeOnly,
                buildAccountSnapshot: runtimeOnly,
                buildChannelSummary: runtimeOnly,
              },
        ),
      ];
      const accounts = (await getHealthSnapshot({ probe: true })).channels[id]?.accounts;
      if (withSibling) {
        expect(accounts).toMatchObject({
          default: { configured: true, tokenStatus: "configured_unavailable" },
          healthy: { configured: true, name: "Resolved healthy account" },
        });
        expect(probeAccount).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            account: expect.objectContaining({ accountId: "healthy", token: "healthy-token" }),
          }),
        );
        expect(buildAccountSnapshot).toHaveBeenCalledTimes(1);
      } else {
        expect(accounts?.default?.configured).toBeUndefined();
        expect(accounts?.default?.stateReason).toBe("configuration status unavailable");
        expect(runtimeOnly).not.toHaveBeenCalled();
      }
    },
  );

  it("bounds probes by the fixed gateway collection deadline", async () => {
    testConfig = {
      session: { store: "/tmp/x" },
      channels: { telegram: { botToken: "123:test" } },
    };
    const timeouts: number[] = [];
    probeTelegramAccountForTestOverride = async (_account, timeoutMs) => {
      timeouts.push(timeoutMs);
      return { ok: true };
    };

    await getHealthSnapshot();

    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toBeGreaterThan(0);
    expect(timeouts[0]).toBeLessThanOrEqual(7_000);
  });

  it("preserves runtime state and probe payloads when plugin summaries omit them", async () => {
    testConfig = { channels: { telegram: { botToken: "t-1" } } };
    buildTelegramHealthSummaryForTest = (snapshot) => ({
      accountId: snapshot.accountId,
      configured: Boolean(snapshot.configured),
    });
    probeTelegramAccountForTestOverride = async () => ({
      ok: true,
      bot: { username: "runtime_bot" },
    });

    const snap = await getHealthSnapshot({
      runtimeSnapshot: channelRuntime("telegram", {
        accountId: "default",
        running: true,
        connected: true,
        lastConnectedAt: 123,
        healthState: "reconnecting",
      }),
    });
    expect(snap.channels.telegram).toMatchObject({
      running: true,
      connected: true,
      lastConnectedAt: 123,
      healthState: "reconnecting",
      probe: { bot: { username: "runtime_bot" } },
      accounts: {
        default: {
          running: true,
          connected: true,
          healthState: "reconnecting",
          probe: { ok: true },
        },
      },
    });
  });

  it.each([
    {
      name: "available credentials",
      token: "discord-token",
      tokenStatus: "available",
      lastConnectedAt: 123,
      expectedRuntime: { running: true, connected: true },
    },
    {
      name: "unavailable SecretRef credentials",
      token: { source: "env", provider: "default", id: "MISSING_DISCORD_BOT_TOKEN" },
      tokenStatus: "configured_unavailable",
      lastConnectedAt: undefined,
      expectedRuntime: {},
    },
  ])(
    "merges inspected $name with runtime state",
    async ({ token, tokenStatus, lastConnectedAt, expectedRuntime }) => {
      testConfig = { channels: { discord: { token } } };
      healthPluginsForTest = [createDiscordHealthPlugin()];

      const snap = await getHealthSnapshot({
        probe: false,
        includeSensitive: false,
        runtimeSnapshot: channelRuntime("discord", {
          accountId: "default",
          running: true,
          connected: true,
          ...(lastConnectedAt === undefined ? {} : { lastConnectedAt }),
        }),
      });
      const expected = {
        configured: true,
        ...expectedRuntime,
        tokenSource: "config",
        tokenStatus,
      };
      expect(snap.channels.discord).toMatchObject({ ...expected, accounts: { default: expected } });
    },
  );

  it("redacts base URL credentials returned by channel summary hooks", async () => {
    testConfig = { channels: { discord: { token: "test" } } };
    const plugin = createDiscordHealthPlugin();
    plugin.status = {
      ...plugin.status,
      buildChannelSummary: () => ({
        configured: true,
        baseUrl: [
          "https://summary-user",
          ":",
          "summary-pass",
          "@chat.example.test/?to",
          "ken=test",
        ].join(""),
      }),
    };
    healthPluginsForTest = [plugin];

    const snap = await getHealthSnapshot({ probe: false, includeSensitive: false });
    const expected = { baseUrl: "https://chat.example.test/?token=***" };
    expect(snap.channels.discord).toMatchObject({ ...expected, accounts: { default: expected } });
  });

  it("omits secret runtime fields and raw probe payloads from non-sensitive health snapshots", async () => {
    testConfig = { channels: { telegram: { botToken: "t-1" } } };
    buildTelegramHealthSummaryForTest = (snapshot) => ({
      accountId: snapshot.accountId,
      configured: Boolean(snapshot.configured),
      probe: { ok: true, token: "test-token" },
    });
    probeTelegramAccountForTestOverride = async () => ({
      ok: true,
      bot: { username: "runtime_bot" },
      token: "test-token",
    });

    const snap = await getHealthSnapshot({
      includeSensitive: false,
      runtimeSnapshot: channelRuntime("telegram", {
        accountId: "default",
        connected: true,
        lastConnectedAt: 123,
        channelAccessToken: "line-token",
        channelSecret: "line-secret", // pragma: allowlist secret
        webhookUrl: "https://example.test/hook?secret=1",
      }),
    });
    const telegram = snap.channels.telegram!;
    expect(telegram.connected).toBe(true);
    expect(telegram.lastConnectedAt).toBe(123);
    expect(telegram.probe).toBeUndefined();
    expect(telegram["channelAccessToken"]).toBeUndefined();
    expect(telegram["channelSecret"]).toBeUndefined();
    expect(telegram["webhookUrl"]).toBeUndefined();
    expect(telegram.accounts?.default?.connected).toBe(true);
    expect(telegram.accounts?.default?.probe).toBeUndefined();
    expect(telegram.accounts?.default?.["channelAccessToken"]).toBeUndefined();
  });

  it("keeps redacted failed probes in non-sensitive health snapshots", async () => {
    healthPluginsForTest = [createIMessageHealthPlugin()];
    testConfig = { channels: { imessage: { enabled: true } } };

    const snap = await getHealthSnapshot({
      includeSensitive: false,
    });
    const imessage = snap.channels.imessage!;
    const expectedProbe = {
      ok: false,
      error:
        "imsg cannot access ~/Library/Messages/chat.db. Grant Full Disk Access to the Gateway/launcher process and restart Gateway.",
    };
    expect(imessage.configured).toBe(true);
    expect(imessage.probe).toEqual(expectedProbe);
    expect(imessage.accounts?.default?.probe).toEqual(expectedProbe);
  });

  it("omits generic failed probe errors from non-sensitive health snapshots", async () => {
    testConfig = { channels: { telegram: { botToken: "bad-token" } } };
    probeTelegramAccountForTestOverride = async () => ({
      ok: false,
      status: null,
      error: "network down with private diagnostic",
      elapsedMs: 0,
    });

    const snap = await getHealthSnapshot({
      includeSensitive: false,
    });
    const telegram = snap.channels.telegram!;

    expect(telegram.configured).toBe(true);
    expect(telegram.probe).toBeUndefined();
    expect(telegram.accounts?.default?.probe).toBeUndefined();
  });
});
