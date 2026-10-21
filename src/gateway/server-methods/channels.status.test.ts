/**
 * Gateway channels.status method tests.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type {
  ChannelAccountSnapshot,
  ChannelPlugin,
  ChannelStatusIssue,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createPluginRecord } from "../../plugins/status.test-fixtures.js";
import { setActiveDegradedSecretOwners } from "../../secrets/runtime-degraded-state.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import type { CallGatewayOptions } from "../call.js";
import { createChannelManager } from "../server-channels.js";
import { requireGatewayRecord } from "../test-helpers.assertions.js";
import {
  channelAccounts,
  DEGRADED_EVENT_LOOP_HEALTH,
  createChannelPlugin,
  createChannelDeadlineFixture,
  createRecordedHealthFixture,
  createQueuedSummaryFixture,
  RECORDED_CHANNEL_HEALTH_CASES,
  buildChannelTestUiCatalog,
  createRecordedAccountSnapshots,
  createChannelsStatusHarness,
  firstAccount,
  firstCallArgs,
} from "./channels.status.test-helpers.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
  getRuntimeSnapshot: vi.fn(),
  listChannelPlugins: vi.fn(),
  normalizeChannelId: vi.fn<(value: string) => string | null>((value) => value),
  listReadOnlyChannelPluginsForConfig: vi.fn(),
  buildChannelUiCatalog: vi.fn(),
  buildChannelAccountSnapshotFromAccount: vi.fn(),
  getChannelActivity: vi.fn(() => ({ inboundAt: null, outboundAt: null })),
  callGateway: vi.fn(),
  note: vi.fn(),
}));

vi.mock("../call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../call.js")>()),
  callGateway: mocks.callGateway,
}));

// mock-isolation: Channel delivery starts after readiness, without inspecting host services.
vi.mock("../../cli/daemon-cli/diagnostic-readiness.js", () => ({
  waitForGatewayDiagnosticReadiness: vi.fn(async () => undefined),
}));

vi.mock("../../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
  readConfigFileSnapshot: vi.fn(async () => ({
    config: {},
    path: "openclaw.config.json",
    raw: "{}",
  })),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: mocks.listChannelPlugins,
  getLoadedChannelPlugin: vi.fn(),
  getChannelPlugin: vi.fn(),
  normalizeChannelId: mocks.normalizeChannelId,
}));

// mock-isolation: Status RPC fixtures supply their channel inventory without persisted account discovery.
vi.mock("../../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfigAsync: async (...args: unknown[]) =>
    mocks.listReadOnlyChannelPluginsForConfig(...args),
}));

vi.mock("../../channels/plugins/catalog.js", () => ({
  buildChannelUiCatalog: mocks.buildChannelUiCatalog,
}));

vi.mock("../../channels/plugins/status.js", () => ({
  buildChannelAccountSnapshotFromAccount: mocks.buildChannelAccountSnapshotFromAccount,
}));

vi.mock("../../infra/channel-activity.js", () => ({
  getChannelActivity: mocks.getChannelActivity,
}));

import { channelsHandlers } from "./channels.js";

const runStatus = createChannelsStatusHarness({
  handler: expectDefined(channelsHandlers["channels.status"], "channels.status handler"),
  getRuntimeConfig: mocks.getRuntimeConfig,
  getRuntimeSnapshot: mocks.getRuntimeSnapshot,
});

function usePlugins(...plugins: Array<{ id: string }>) {
  mocks.listChannelPlugins.mockReturnValue(plugins);
}

async function useRealSnapshotBuilder() {
  const { buildChannelAccountSnapshotFromAccount } = await vi.importActual<
    typeof import("../../channels/plugins/status.js")
  >("../../channels/plugins/status.js");
  mocks.buildChannelAccountSnapshotFromAccount.mockImplementation(
    buildChannelAccountSnapshotFromAccount,
  );
}

function fail(message: string): never {
  throw new Error(message);
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function unavailableOwner(ownerId: string, path: string, degradationState?: "cold" | "stale") {
  setActiveDegradedSecretOwners([
    {
      ownerKind: "account",
      ownerId,
      state: "unavailable",
      degradationState,
      paths: [path],
      refKeys: degradationState ? ["env:default:PRIVATE_TOKEN_REFERENCE"] : [],
      reason: "secret reference was not found",
    },
  ]);
}

function recordAccount(snapshot: Partial<ChannelAccountSnapshot>, channel = "whatsapp") {
  const account = {
    accountId: "default",
    enabled: true,
    configured: true,
    running: true,
    connected: true,
    ...snapshot,
  };
  mocks.getRuntimeSnapshot.mockReturnValue({
    channels: {},
    channelAccounts: { [channel]: { [account.accountId]: account } },
  });
}

describe("channelsHandlers channels.status", () => {
  afterEach(() => {
    vi.useRealTimers();
    setActiveDegradedSecretOwners([]);
    setActivePluginRegistry(createTestRegistry([]));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.normalizeChannelId.mockImplementation((value: string) => value);
    mocks.listReadOnlyChannelPluginsForConfig.mockImplementation(() => mocks.listChannelPlugins());
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.buildChannelUiCatalog.mockImplementation(buildChannelTestUiCatalog);
    mocks.buildChannelAccountSnapshotFromAccount.mockResolvedValue({
      accountId: "default",
      configured: true,
    });
    usePlugins(createChannelPlugin());
    mocks.getRuntimeSnapshot.mockImplementation(() => ({
      channels: {},
      channelAccounts: Object.fromEntries(
        mocks.listChannelPlugins().map((plugin: { id: string }) => [
          plugin.id,
          {
            default: { accountId: "default", configured: true, running: true },
          },
        ]),
      ),
    }));
  });

  it("reads recorded health without resolving credentials or waiting for live status hooks", async () => {
    const { channelIds, plugins, unavailable } = createRecordedHealthFixture();
    usePlugins(...plugins);
    mocks.buildChannelAccountSnapshotFromAccount.mockImplementation(unavailable);
    const current: ChannelAccountSnapshot & { guests: { used: number } } = {
      accountId: "default",
      enabled: true,
      configured: true,
      running: true,
      connected: true,
      lifecycle: "ready",
      guests: { used: 7 },
    };
    mocks.getRuntimeSnapshot.mockImplementation(() => ({
      channels: {},
      channelAccounts: Object.fromEntries(channelIds.map((id) => [id, { default: current }])),
    }));

    const first = await runStatus({ probe: false });
    expect(first.partial).toBeUndefined();
    expect(firstAccount(first, "x")).toMatchObject({
      running: true,
      connected: true,
      guests: { used: 7 },
    });
    expect(requireGatewayRecord(first.channels, "summaries").slack).toMatchObject({
      running: true,
      connected: true,
    });
    current.connected = false;
    current.lifecycle = "recovering";
    const second = await runStatus({});
    expect(firstAccount(second, "slack")).toMatchObject({
      connected: false,
      healthState: "disconnected",
    });
    expect(firstAccount(first, "slack").connected).toBe(true);
    expect(unavailable).not.toHaveBeenCalled();
    expect(mocks.getRuntimeSnapshot).toHaveBeenLastCalledWith({
      channelId: undefined,
      inspectAccounts: false,
    });
  });

  it("reports unknown configuration without invoking operational account resolution", async () => {
    mocks.getRuntimeSnapshot.mockReturnValue({ channels: {}, channelAccounts: {} });
    const payload = await runStatus({});
    expect(firstAccount(payload)).toMatchObject({
      running: false,
      stateReason: "configuration status unavailable",
      healthState: "not-running",
    });
    expect(firstAccount(payload).configured).toBeUndefined();
  });

  it("keeps filtered account diagnostics without inspecting unrelated channels", async () => {
    const resolveAccount = vi.fn(() => fail("unavailable account must not resolve credentials"));
    const selected = createChannelTestPluginBase({
      id: "whatsapp",
      config: {
        listAccountIds: () => ["disabled", "unavailable"],
        resolveAccount,
        inspectAccount: () => ({ enabled: false, configured: true, name: "Disabled account" }),
      },
    });
    const inspectUnrelated = vi.fn(() => fail("unrelated channel inspection failed"));
    const unrelated = createChannelTestPluginBase({
      id: "discord",
      config: { inspectAccount: inspectUnrelated },
    });
    const registry = createTestRegistry(
      [selected, unrelated].map((plugin) => ({ pluginId: plugin.id, plugin, source: "test" })),
    );
    setActivePluginRegistry(registry);
    unavailableOwner("whatsapp:unavailable", "channels.whatsapp.accounts.unavailable.token");
    usePlugins(selected, unrelated);
    const manager = createChannelManager({
      scheduler: createTestGatewayScheduler(),
      getRuntimeConfig: mocks.getRuntimeConfig,
      getPluginRegistry: () => registry,
      channelLogs: {},
      channelRuntimeEnvs: {},
    });
    const payload = await runStatus(
      { channel: "whatsapp", probe: false },
      { getRuntimeSnapshot: manager.getRuntimeSnapshot },
    );

    expect(payload.partial).toBeUndefined();
    expect(channelAccounts(payload, "whatsapp")).toMatchObject([
      {
        accountId: "disabled",
        enabled: false,
        configured: true,
        running: false,
        name: "Disabled account",
      },
      {
        accountId: "unavailable",
        running: false,
        lifecycle: "blocked",
        lastError: expect.stringContaining("configured but unavailable"),
      },
    ]);
    expect(Object.keys(requireGatewayRecord(payload.channelAccounts, "channel accounts"))).toEqual([
      "whatsapp",
    ]);
    expect(inspectUnrelated).not.toHaveBeenCalled();
    expect(resolveAccount).not.toHaveBeenCalled();
  });

  it.each([undefined, true, false])(
    "channels.status preserves published plugin defaults at the plugin consumer (enabled=%s)",
    async (enabled) => {
      const activation = enabled === undefined ? {} : { enabled };
      const runtimeConfig: OpenClawConfig = {
        plugins: {
          entries: {
            browser: { ...activation, config: {} },
            "google-meet": { ...activation, config: { defaultMode: "agent" } },
            "teams-meetings": { ...activation, config: { defaultMode: "agent" } },
            "zoom-meetings": { ...activation, config: { defaultMode: "agent" } },
          },
        },
      };
      const publishedConfig = structuredClone(runtimeConfig);
      const probeAccount = vi.fn(async (_params: { cfg: OpenClawConfig }) => ({ ok: true }));
      mocks.getRuntimeConfig.mockReturnValue(runtimeConfig);
      mocks.listChannelPlugins.mockReturnValue([
        {
          ...createChannelTestPluginBase({ id: "whatsapp" }),
          status: { probeAccount },
        },
      ]);

      const payload = await runStatus({ probe: true, timeoutMs: 2000 });

      expect(payload.partial).toBeUndefined();
      expect(probeAccount).toHaveBeenCalledOnce();
      expect(probeAccount.mock.calls[0]?.[0].cfg).toStrictEqual(publishedConfig);
      expect(probeAccount.mock.calls[0]?.[0].cfg).toBe(runtimeConfig);
      const snapshotArgs = requireGatewayRecord(
        firstCallArgs(mocks.buildChannelAccountSnapshotFromAccount),
        "snapshot args",
      );
      expect(snapshotArgs.cfg).toBe(runtimeConfig);
      expect(firstAccount(payload, "whatsapp").configured).toBe(true);
    },
  );

  it.each([
    { listed: false, probe: false },
    { listed: false, probe: true },
    { listed: true, probe: false },
    { listed: true, probe: true },
  ])(
    "reports admitted accounts safely without resolving removed configuration (listed=$listed, probe=$probe)",
    async ({ listed, probe }) => {
      const configured = { accountId: "primary", enabled: true, configured: true };
      const resolveAccount = vi.fn((_cfg: OpenClawConfig, accountId?: string | null) => {
        if (accountId !== "primary") {
          throw new Error("admitted account has no current operational configuration");
        }
        return configured;
      });
      const probeAccount = vi.fn(async () => ({ ok: true, identity: "configured-provider" }));
      const auditAccount = vi.fn(async () => ({ ok: true }));
      const buildChannelSummary = vi.fn(() => ({ configured: true, name: "Configured summary" }));
      const plugin: ChannelPlugin<typeof configured> = {
        ...createChannelTestPluginBase({ id: "whatsapp" }),
        config: {
          listAccountIds: () => (listed ? ["primary"] : []),
          resolveAccount,
          inspectAccount: resolveAccount,
          isEnabled: (account) => account.enabled,
          isConfigured: (account) => account.configured,
        },
        status: { probeAccount, auditAccount, buildChannelSummary },
      };
      usePlugins(plugin);
      await useRealSnapshotBuilder();
      const { recovered, recoveredFacts, retrying } = createRecordedAccountSnapshots();
      const payload = await runStatus(
        { probe },
        {
          getRuntimeSnapshot: () => ({
            channels: { whatsapp: { accountId: listed ? "primary" : "default" } },
            channelAccounts: { whatsapp: { recovered, retrying } },
          }),
        },
      );

      expect(payload.partial).toBeUndefined();
      expect(payload.channelDefaultAccountId).toEqual({ whatsapp: listed ? "primary" : "default" });
      const accounts = channelAccounts(payload, "whatsapp");
      expect(accounts.map((account) => account.accountId)).toEqual(
        listed ? ["primary", "recovered", "retrying"] : ["recovered", "retrying"],
      );
      const admitted = expectDefined(
        accounts.find((account) => account.accountId === "recovered"),
        "admitted account status",
      );
      expect(admitted).toMatchObject({
        ...recoveredFacts,
        baseUrl: "https://chat.example.test/?token=***",
      });
      expect(admitted.connected).toBeUndefined();
      for (const field of [
        "channelSecret",
        "channelAccessToken",
        "webhookUrl",
        "publicKey",
        "probe",
        "audit",
        "application",
        "bot",
        "profile",
      ]) {
        expect(admitted[field], field).toBeUndefined();
      }
      expect(accounts.find((account) => account.accountId === "retrying")).toMatchObject(retrying);
      expect(resolveAccount.mock.calls.map((call) => call[1])).not.toContain("recovered");
      expect(resolveAccount.mock.calls.map((call) => call[1])).not.toContain("retrying");
      for (const hook of [probeAccount, auditAccount, buildChannelSummary]) {
        expect(hook).toHaveBeenCalledTimes(listed && probe ? 1 : 0);
      }
      if (listed && probe) {
        expect(accounts[0]).toMatchObject({ accountId: "primary", configured: true });
        expect(requireGatewayRecord(payload.channels, "channel summaries").whatsapp).toMatchObject({
          name: "Configured summary",
        });
      }
    },
  );

  it("reports policy and deferred publication without changing healthy transport status", async () => {
    const policyIssue: ChannelStatusIssue = {
      channel: "guildchat",
      accountId: "default",
      kind: "config",
      message: "No groups are allowed.",
      fix: "Add an allowed group.",
    };
    usePlugins(
      createChannelPlugin({ id: "guildchat", collectStatusIssues: () => [policyIssue] }),
      createChannelPlugin({ id: "sibling" }),
    );
    recordAccount({ lastError: null }, "guildchat");
    const payload = await runStatus(
      { channel: "guildchat" },
      {
        getDeferredChannelReloads: () => [
          { channel: "guildchat", publicationPending: true },
          { channel: "unselected", publicationPending: true },
        ],
      },
    );

    expect(payload.statusIssues).toEqual([
      policyIssue,
      expect.objectContaining({
        channel: "guildchat",
        kind: "config",
        message: expect.stringContaining("previous configuration is still in use"),
        fix: expect.stringContaining("Stopping and starting the channel does not apply"),
      }),
    ]);
    expect(firstAccount(payload, "guildchat")).toMatchObject({
      running: true,
      connected: true,
      lastError: null,
    });
    expect(payload.partial).toBeUndefined();
    expect(payload.warnings).toBeUndefined();
  });

  it("clears deferred diagnostics and distinguishes work after publication", async () => {
    const payload = await runStatus(
      {},
      {
        getDeferredChannelReloads: () => [{ channel: "whatsapp", publicationPending: false }],
      },
    );
    expect(payload.statusIssues).toEqual([
      expect.objectContaining({
        message: "Channel reload is deferred while active work finishes.",
      }),
    ]);
    expect((await runStatus({}, { getDeferredChannelReloads: () => [] })).statusIssues).toEqual([]);
  });

  it("retains account status when a plugin diagnostic collector fails", async () => {
    usePlugins(
      createChannelPlugin({
        collectStatusIssues: () => fail("diagnostic unavailable"),
      }),
    );
    const payload = await runStatus({});
    expect(firstAccount(payload).configured).toBe(true);
    expect(payload.partial).toBe(true);
    expect(payload.warnings).toContain(
      "whatsapp status diagnostics failed: Error: diagnostic unavailable",
    );
  });

  it("reports recorded account state while reload has paused plugin callbacks", async () => {
    const refuse = vi.fn(() => fail("plugin is quiesced"));
    const plugin = createChannelPlugin({
      probeAccount: refuse,
      buildChannelSummary: refuse,
      collectStatusIssues: refuse,
    });
    plugin.config.listAccountIds = refuse;
    plugin.config.resolveAccount = refuse;
    usePlugins(plugin);
    const account = { accountId: "recorded", configured: true, running: false };
    const payload = await runStatus(
      { probe: true },
      {
        getRuntimeSnapshot: () => ({
          channels: { whatsapp: account },
          channelAccounts: { whatsapp: { recorded: account } },
          reloadingChannels: new Map([["whatsapp", "recorded"]]),
        }),
      },
    );
    expect(firstAccount(payload)).toEqual(account);
    expect(payload.channelDefaultAccountId).toEqual({ whatsapp: "recorded" });
    expect(payload.partial).toBe(true);
    expect(payload.warnings).toEqual([
      "whatsapp: plugin runtime is paused for reload; reporting recorded account state",
    ]);
    expect(payload.statusIssues).toEqual([
      expect.objectContaining({
        channel: "whatsapp",
        accountId: "recorded",
        kind: "runtime",
        message: "Channel is enabled and configured, but its runtime is not running.",
      }),
    ]);
    expect(refuse).not.toHaveBeenCalled();
    expect(mocks.buildChannelAccountSnapshotFromAccount).not.toHaveBeenCalled();
  });

  it("redacts base URL credentials returned by channel summary hooks", async () => {
    usePlugins(
      createChannelPlugin({
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
      }),
    );

    const payload = await runStatus({ probe: true, timeoutMs: 2000 });
    expect(payload.channels).toMatchObject({
      whatsapp: { baseUrl: "https://chat.example.test/?token=***" },
    });
  });

  it.each(["cold", "stale"] as const)(
    "reports a %s secret owner without losing healthy sibling accounts",
    async (degradationState) => {
      const probeAccount = vi.fn(async () => ({ ok: true }));
      const buildChannelSummary = vi.fn(() => ({ configured: true, running: true }));
      const degraded = createChannelPlugin({ id: "degraded", probeAccount, buildChannelSummary });
      const resolveAccount = vi.fn(() => {
        if (degradationState === "cold") {
          throw new Error("unresolved operational credential");
        }
        return {};
      });
      degraded.config.resolveAccount = resolveAccount;
      const healthyProbe = vi.fn(async () => ({ ok: true }));
      usePlugins(degraded, createChannelPlugin({ id: "healthy", probeAccount: healthyProbe }));
      unavailableOwner("degraded:default", "channels.degraded.token", degradationState);

      const payload = await runStatus({ probe: true, timeoutMs: 1000 });

      expect(payload.partial).toBeUndefined();
      expect(firstAccount(payload, "healthy").configured).toBe(true);
      expect(healthyProbe).toHaveBeenCalledOnce();
      if (degradationState === "cold") {
        expect(firstAccount(payload, "degraded")).toMatchObject({
          accountId: "default",
          enabled: true,
          configured: true,
          running: false,
          lifecycle: "blocked",
          lastError: expect.stringContaining("configured but unavailable"),
        });
        expect(requireGatewayRecord(payload.channels, "channels").degraded).toMatchObject({
          configured: true,
          lastError: expect.stringContaining("configured but unavailable"),
        });
      }
      for (const hook of [resolveAccount, probeAccount, buildChannelSummary]) {
        expect(hook).toHaveBeenCalledTimes(degradationState === "cold" ? 0 : 1);
      }
      expect(JSON.stringify(payload)).not.toContain("PRIVATE_TOKEN_REFERENCE");
    },
  );

  it.each(["load", "register", "validation"] as const)(
    "keeps a channel visible after its plugin fails during %s",
    async (failurePhase) => {
      const credential = "synthetic-loader-credential-that-must-not-escape";
      const failedProbe = vi.fn();
      const failed = createChannelPlugin({ id: "broken-channel", probeAccount: failedProbe });
      const healthyProbe = vi.fn(async () => ({ ok: true }));
      const healthy = createChannelPlugin({ id: "healthy", probeAccount: healthyProbe });
      usePlugins(healthy);
      failed.config.listAccountIds = () => ["default", "disabled"];
      mocks.getRuntimeConfig.mockReturnValue({
        logging: { redactSensitive: "off", redactPatterns: ["never-match-custom"] },
        channels: { "broken-channel": { accounts: { Disabled: { enabled: false } } } },
      });
      mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([failed, healthy]);
      setActivePluginRegistry({
        ...createTestRegistry([]),
        plugins: [
          createPluginRecord({
            id: "broken-owner",
            enabled: true,
            status: "error",
            failurePhase,
            channelIds: ["broken-channel"],
            error: `missing SDK export; Authorization: Bearer ${credential}\n${"context ".repeat(300)}`,
          }),
        ],
      });

      const payload = await runStatus({ probe: true, timeoutMs: 1000 });

      expect(JSON.stringify(payload)).not.toContain(credential);
      const lastError = firstAccount(payload, "broken-channel").lastError;
      expect(String(lastError).length).toBeLessThan(1200);
      expect(lastError).toContain("run openclaw doctor");
      expect(firstAccount(payload, "broken-channel")).toMatchObject({
        configured: true,
        running: false,
        lifecycle: "blocked",
        lastError: expect.stringContaining("missing SDK export"),
      });
      expect(requireGatewayRecord(payload.channels, "channels")["broken-channel"]).toMatchObject({
        configured: true,
        lastError: expect.stringContaining("missing SDK export"),
      });
      expect(channelAccounts(payload, "broken-channel")).toContainEqual(
        expect.objectContaining({
          accountId: "disabled",
          enabled: false,
          lastError: expect.stringContaining("missing SDK export"),
        }),
      );
      expect(failedProbe).not.toHaveBeenCalled();
      expect(healthyProbe).toHaveBeenCalledOnce();
      mocks.normalizeChannelId.mockReturnValueOnce(null);
      const filtered = await runStatus({ channel: "broken-channel", probe: false });
      expect(firstAccount(filtered, "broken-channel").lifecycle).toBe("blocked");
      expect(requireGatewayRecord(filtered.channelAccounts, "accounts")).not.toHaveProperty(
        "healthy",
      );
    },
  );

  it.each(["sync", "async"] as const)(
    "shares the capped deadline across preparation and live %s hooks",
    async (hooks) => {
      vi.useFakeTimers();
      const resolutionMs = hooks === "async" ? 900 : 0;
      const runtimeConfig = { channels: { whatsapp: { enabled: true } } };
      mocks.getRuntimeConfig.mockReturnValue(runtimeConfig);
      const probeAccount = vi.fn(async () => {
        await delay(400);
        return { ok: true };
      });
      const auditAccount = vi.fn(async () => ({ ok: true }));
      const account = {};
      const plugin = createChannelPlugin({ probeAccount });
      plugin.status = { ...plugin.status, auditAccount };
      plugin.config.resolveAccount = () => {
        if (hooks === "async") {
          throw new Error("legacy account hook used");
        }
        return account;
      };
      if (hooks === "async") {
        plugin.config.resolveAccountAsync = async () => {
          await delay(resolutionMs);
          return account;
        };
      }
      usePlugins(plugin);
      const run = runStatus({ probe: true, timeoutMs: 999_999 });
      await vi.advanceTimersByTimeAsync(1300);
      await run;
      const probeArgs = firstCallArgs(probeAccount);
      expect(probeArgs.timeoutMs).toBe(30_000 - resolutionMs);
      expect(probeArgs.cfg).toBe(runtimeConfig);
      expect(probeArgs.account).toBe(account);
      const auditArgs = firstCallArgs(auditAccount);
      expect(auditArgs.timeoutMs).toBe(30_000 - resolutionMs - 400);
    },
  );

  it("runs channel probes concurrently and preserves deterministic status-map order", async () => {
    vi.useFakeTimers();
    const started: string[] = [];
    const createDelayedProbe = (id: string) => async () => {
      started.push(id);
      await delay(1000);
      return { ok: true };
    };
    usePlugins(
      createChannelPlugin({ id: "zeta", probeAccount: createDelayedProbe("zeta") }),
      createChannelPlugin({ id: "alpha", probeAccount: createDelayedProbe("alpha") }),
    );

    const startedAt = Date.now();
    const run = runStatus({ probe: true, timeoutMs: 2000 });

    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["alpha", "zeta"]);
    await vi.advanceTimersByTimeAsync(1000);
    const payload = await run;

    expect(Date.now() - startedAt).toBe(1000);
    expect(payload.channelOrder).toEqual(["zeta", "alpha"]);
    expect(Object.keys(requireGatewayRecord(payload.channels, "channels payload"))).toEqual([
      "alpha",
      "zeta",
    ]);
  });

  it("fences summaries queued before another microtask exhausts their deadline", async () => {
    vi.useFakeTimers();
    const { summary, plugins } = createQueuedSummaryFixture();
    usePlugins(...plugins);
    const payload = await runStatus({ probe: true, timeoutMs: 1000 });
    expect(summary).not.toHaveBeenCalled();
    expect(firstAccount(payload, "beta")).toMatchObject({ running: true });
    expect(payload.partial).toBe(true);
  });

  it.each([-60_000, 60_000])(
    "keeps the live probe deadline on the monotonic clock when wall time jumps by %i ms",
    async (wallJumpMs) => {
      vi.useFakeTimers();
      const healthyProbe = vi.fn(async () => {
        await delay(500);
        return { ok: true, identity: "healthy" };
      });
      usePlugins(createChannelPlugin({ id: "healthy", probeAccount: healthyProbe }));
      await useRealSnapshotBuilder();
      const run = runStatus({ probe: true, timeoutMs: 1000 });

      await vi.advanceTimersByTimeAsync(0);
      vi.setSystemTime(Date.now() + wallJumpMs);
      await vi.advanceTimersByTimeAsync(600);
      const payload = await run;

      expect(firstAccount(payload, "healthy")).toMatchObject({
        probe: { ok: true, identity: "healthy" },
      });
      expect(payload.partial).toBeUndefined();
    },
  );

  it("preserves channel account rows when a live probe throws", async () => {
    const probeAccount = vi.fn(async () => fail("probe failed"));
    mocks.buildChannelAccountSnapshotFromAccount.mockImplementation(
      async ({ accountId, probe }) => ({ accountId, configured: true, probe }),
    );
    usePlugins(createChannelPlugin({ probeAccount }));

    const payload = await runStatus({ probe: true, timeoutMs: 1000 });

    expect(firstAccount(payload)).toMatchObject({
      accountId: "default",
      lastError: expect.stringContaining("probe failed"),
      lastProbeAt: expect.any(Number),
      probe: { ok: false, error: expect.stringContaining("probe failed") },
    });
  });

  it("marks account snapshot failures partial", async () => {
    mocks.buildChannelAccountSnapshotFromAccount.mockRejectedValue(new Error("snapshot failed"));

    const payload = await runStatus({ probe: true, timeoutMs: 1000 });

    expect(payload.partial).toBe(true);
    expect(payload.warnings).toEqual(["whatsapp:default status failed: Error: snapshot failed"]);
    const channels = requireGatewayRecord(payload.channels, "channels payload");
    expect(channels.whatsapp).toEqual({ configured: false });
  });

  it("isolates a failed channel status task while a sibling succeeds", async () => {
    const broken = createChannelPlugin({ id: "broken" });
    broken.config.listAccountIds = () => fail("channel failed");
    usePlugins(broken, createChannelPlugin({ id: "healthy" }));

    const payload = await runStatus({ probe: false, timeoutMs: 1000 });

    expect(payload.partial).toBe(true);
    expect(payload.warnings).toEqual(["broken channel status failed: Error: channel failed"]);
    expect(requireGatewayRecord(payload.channels, "channels payload").healthy).toMatchObject({
      configured: true,
    });
  });

  it.each(
    ["resolve", "configured", "probe", "audit", "snapshot", "summary"].flatMap((step) =>
      [false, true].map((synchronous) => ({ step, synchronous })),
    ),
  )(
    "bounds the channel when $step exceeds its deadline (synchronous=$synchronous)",
    async ({ step, synchronous }) => {
      vi.useFakeTimers();
      const { plugin: hanging, describeAccount } = createChannelDeadlineFixture(step, synchronous);
      const healthyProbe = vi.fn(async () => ({ ok: true, identity: "healthy" }));
      usePlugins(hanging, createChannelPlugin({ id: "healthy", probeAccount: healthyProbe }));
      await useRealSnapshotBuilder();
      const run = runStatus({ probe: true, timeoutMs: 1000 });

      if (!synchronous) {
        await vi.advanceTimersByTimeAsync(1000);
      }
      const payload = await run;

      if (step === "snapshot") {
        expect(describeAccount).not.toHaveBeenCalled();
      }
      expect(firstAccount(payload, "hanging")).toMatchObject({
        running: true,
        lastError: "status timed out after 1000ms",
      });
      expect(firstAccount(payload, "healthy")).toMatchObject(
        synchronous ? { running: true } : { probe: { ok: true, identity: "healthy" } },
      );
      expect(payload.partial).toBe(true);
      expect(payload.warnings).toContain("hanging status timed out after 1000ms");
    },
  );

  it.each([100, 2_000, 7_000])(
    "delivers partial channel results to Doctor after a %i ms round-trip",
    async (roundTripMs) => {
      const { checkGatewayHealth } = await import("../../commands/doctor-gateway-health.js");
      await import("../../agents/tools/in-process-gateway.js");
      vi.useFakeTimers();
      const statusStarted = createDeferred();
      const channelsStarted = createDeferred();
      usePlugins(
        createChannelPlugin({
          id: "hanging",
          probeAccount: () => new Promise(() => {}),
        }),
        createChannelPlugin({
          id: "healthy",
          probeAccount: async () => ({ ok: true }),
          collectStatusIssues: () => [
            {
              channel: "healthy",
              accountId: "default",
              kind: "config",
              message: "Check routing",
            },
          ],
        }),
      );
      mocks.buildChannelAccountSnapshotFromAccount.mockImplementation(
        async ({ accountId, probe }) => ({ accountId, configured: true, probe }),
      );
      let channelPayload: Record<string, unknown> | undefined;
      mocks.callGateway.mockImplementation(({ method, params, timeoutMs }: CallGatewayOptions) => {
        if (timeoutMs == null) {
          throw new Error("Doctor requests must have a deadline");
        }
        if (method === "diagnostics.stability") {
          return Promise.resolve({});
        }
        return new Promise((resolve, reject) => {
          const deadline = setTimeout(
            () => reject(new Error(`gateway timeout after ${timeoutMs}ms`)),
            timeoutMs,
          );
          const response = async () => {
            await delay(roundTripMs);
            if (method === "status") {
              return { ok: true };
            }
            channelPayload = await runStatus(requireGatewayRecord(params, "request params"));
            return channelPayload;
          };
          void response()
            .then(resolve, reject)
            .finally(() => {
              clearTimeout(deadline);
            });
          (method === "status" ? statusStarted : channelsStarted).resolve();
        });
      });
      const result = checkGatewayHealth({
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        cfg: {},
        timeoutMs: roundTripMs < 3_000 ? 3_000 : 10_000,
      });
      await statusStarted.promise;
      await vi.advanceTimersByTimeAsync(roundTripMs);
      await channelsStarted.promise;
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(result).resolves.toMatchObject({ healthOk: true, authenticated: true });
      const payload = expectDefined(channelPayload, "channel response");
      expect(payload.partial).toBe(true);
      expect(firstAccount(payload, "hanging").lastError).toContain("status timed out");
      expect(firstAccount(payload, "healthy").probe).toEqual({ ok: true });
      expect(mocks.note).toHaveBeenCalledWith(
        expect.stringContaining("Check routing"),
        "Channel warnings",
      );
      expect(mocks.note).not.toHaveBeenCalledWith(
        expect.stringContaining("host may be slow"),
        expect.anything(),
      );
    },
  );

  it("falls back to account-derived channel summaries when summary building fails", async () => {
    usePlugins(
      createChannelPlugin({
        buildChannelSummary: async () => fail("summary failed"),
      }),
    );

    const payload = await runStatus({ probe: true, timeoutMs: 1000 });
    expect(payload.channels).toMatchObject({
      whatsapp: { configured: true, lastError: expect.stringContaining("summary failed") },
    });
    expect(firstAccount(payload)).toMatchObject({
      accountId: "default",
      configured: true,
    });
  });

  it.each(RECORDED_CHANNEL_HEALTH_CASES)(
    "projects recorded $healthState health and event-loop facts",
    async ({ snapshot, healthState }) => {
      recordAccount(snapshot);
      const eventLoop = DEGRADED_EVENT_LOOP_HEALTH;
      const payload = await runStatus({ probe: false }, { getEventLoopHealth: () => eventLoop });
      expect(payload.eventLoop).toBe(eventLoop);
      expect(firstAccount(payload)).toMatchObject({ ...snapshot, healthState });
    },
  );
});
