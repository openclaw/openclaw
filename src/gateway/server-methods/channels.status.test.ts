/**
 * Gateway channels.status method tests.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { requireGatewayRecord } from "../test-helpers.assertions.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type ChannelTestPlugin = {
  id: string;
  config: {
    listAccountIds: () => string[];
    resolveAccount: () => Record<string, never>;
    isEnabled: () => boolean;
    isConfigured: (_account: unknown, cfg: { autoEnabled?: boolean }) => boolean | Promise<boolean>;
  };
  status?: {
    probeAccount?: (params?: unknown) => unknown;
    buildChannelSummary?: () => unknown;
    collectStatusIssues?: () => ChannelStatusIssue[];
  };
};

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
  applyPluginAutoEnable: vi.fn(),
  listChannelPlugins: vi.fn(),
  normalizeChannelId: vi.fn<(value: string) => string | null>((value) => value),
  listReadOnlyChannelPluginsForConfig: vi.fn(),
  buildChannelUiCatalog: vi.fn(),
  buildChannelAccountSnapshotFromAccount: vi.fn(),
  getChannelActivity: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
  readConfigFileSnapshot: vi.fn(async () => ({
    config: {},
    path: "openclaw.config.json",
    raw: "{}",
  })),
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: mocks.applyPluginAutoEnable,
}));

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: mocks.listChannelPlugins,
  getLoadedChannelPlugin: vi.fn(),
  getChannelPlugin: vi.fn(),
  normalizeChannelId: mocks.normalizeChannelId,
}));

vi.mock("../../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: mocks.listReadOnlyChannelPluginsForConfig,
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

function createOptions(
  params: Record<string, unknown>,
  overrides?: Partial<GatewayRequestHandlerOptions>,
): GatewayRequestHandlerOptions {
  return {
    req: { type: "req", id: "req-1", method: "channels.status", params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: {
      getRuntimeConfig: mocks.getRuntimeConfig,
      getRuntimeSnapshot: () => ({
        channels: {},
        channelAccounts: {},
      }),
    },
    ...overrides,
  } as unknown as GatewayRequestHandlerOptions;
}

function createChannelPlugin(
  params: {
    id?: string;
    probeAccount?: (params?: unknown) => unknown;
    buildChannelSummary?: () => unknown;
    collectStatusIssues?: () => ChannelStatusIssue[];
  } = {},
): ChannelTestPlugin {
  return {
    id: params.id ?? "whatsapp",
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({}),
      isEnabled: () => true,
      isConfigured: async (_account, cfg) => Boolean(cfg.autoEnabled),
    },
    ...(params.probeAccount || params.buildChannelSummary || params.collectStatusIssues
      ? {
          status: {
            ...(params.probeAccount ? { probeAccount: params.probeAccount } : {}),
            ...(params.buildChannelSummary
              ? { buildChannelSummary: params.buildChannelSummary }
              : {}),
            ...(params.collectStatusIssues
              ? { collectStatusIssues: params.collectStatusIssues }
              : {}),
          },
        }
      : {}),
  };
}

function configureAutoEnabledChannels(plugins: ChannelTestPlugin[]): void {
  const autoEnabledConfig = { autoEnabled: true };
  mocks.applyPluginAutoEnable.mockReturnValue({ config: autoEnabledConfig, changes: [] });
  mocks.listChannelPlugins.mockReturnValue(plugins);
}

async function runChannelsStatus(
  params: Record<string, unknown>,
  overrides?: Partial<GatewayRequestHandlerOptions>,
) {
  const respond = vi.fn();
  await expectDefined(
    channelsHandlers["channels.status"],
    'channelsHandlers["channels.status"] test invariant',
  )(createOptions(params, { respond, ...overrides }));
  return requireRespondPayload(respond);
}

function channelAccounts(
  payload: Record<string, unknown>,
  channel: string,
): Record<string, unknown>[] {
  const accounts = requireGatewayRecord(payload.channelAccounts, "channel accounts")[
    channel
  ] as unknown[];
  expect(Array.isArray(accounts)).toBe(true);
  return accounts.map((account) => requireGatewayRecord(account, "channel account"));
}

function firstChannelAccount(
  payload: Record<string, unknown>,
  channel: string,
): Record<string, unknown> {
  return expectDefined(
    channelAccounts(payload, channel)[0],
    "channelAccounts(payload, channel)[0] test invariant",
  );
}

function requireFirstCallArg(mock: { mock: { calls: readonly (readonly unknown[])[] } }) {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error("Expected first mock call");
  }
  return call[0];
}

function requireRespondPayload(respond: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = respond.mock.calls[0];
  if (!call) {
    throw new Error("Expected respond call");
  }
  expect(call[0]).toBe(true);
  expect(call[2]).toBeUndefined();
  return requireGatewayRecord(call[1], "respond payload");
}

describe("channelsHandlers channels.status", () => {
  afterEach(() => {
    setActiveDegradedSecretOwners([]);
    setActivePluginRegistry(createTestRegistry([]));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.normalizeChannelId.mockImplementation((value: string) => value);
    mocks.listReadOnlyChannelPluginsForConfig.mockImplementation(() => mocks.listChannelPlugins());
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({ config, changes: [] }));
    mocks.buildChannelUiCatalog.mockReturnValue({
      order: ["whatsapp"],
      labels: { whatsapp: "WhatsApp" },
      detailLabels: { whatsapp: "WhatsApp" },
      systemImages: { whatsapp: undefined },
      entries: { whatsapp: { id: "whatsapp" } },
    });
    mocks.buildChannelAccountSnapshotFromAccount.mockResolvedValue({
      accountId: "default",
      configured: true,
    });
    mocks.getChannelActivity.mockReturnValue({
      inboundAt: null,
      outboundAt: null,
    });
    mocks.listChannelPlugins.mockReturnValue([createChannelPlugin()]);
  });

  it("uses the auto-enabled config snapshot for channel account state", async () => {
    const autoEnabledConfig = { autoEnabled: true };
    mocks.applyPluginAutoEnable.mockReturnValue({ config: autoEnabledConfig, changes: [] });

    const payload = await runChannelsStatus({ probe: false, timeoutMs: 2000 });

    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith({
      config: {},
    });
    const snapshotArgs = requireGatewayRecord(
      requireFirstCallArg(mocks.buildChannelAccountSnapshotFromAccount),
      "snapshot args",
    );
    expect(snapshotArgs.cfg).toBe(autoEnabledConfig);
    expect(snapshotArgs.accountId).toBe("default");
    const channels = requireGatewayRecord(payload.channels, "channels payload");
    const whatsapp = requireGatewayRecord(channels.whatsapp, "whatsapp channel");
    expect(whatsapp.configured).toBe(true);
  });

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
      mocks.listChannelPlugins.mockReturnValue([plugin]);
      const status = await vi.importActual<typeof import("../../channels/plugins/status.js")>(
        "../../channels/plugins/status.js",
      );
      mocks.buildChannelAccountSnapshotFromAccount.mockImplementation(
        status.buildChannelAccountSnapshotFromAccount,
      );
      const baseUrl = new URL("https://chat.example.test/?token=runtime-token");
      baseUrl.username = "runtime-user";
      baseUrl.password = "runtime-password";
      const recovered: ChannelAccountSnapshot = {
        accountId: "recovered",
        enabled: true,
        configured: true,
        running: true,
        lifecycle: "starting",
        tokenSource: "config",
        tokenStatus: "available",
        stateReason: "admitted before configuration changed",
        lastStartAt: 1200,
        lastError: null,
        baseUrl: baseUrl.href,
        channelSecret: "private-channel-secret",
        channelAccessToken: "private-channel-token",
        webhookUrl: "https://private-webhook.example.test/secret",
        publicKey: "private-provider-key",
        probe: { credential: "private-probe" },
        audit: { credential: "private-audit" },
        application: { credential: "private-application" },
        bot: { credential: "private-bot" },
        profile: { credential: "private-profile" },
      };
      const retrying: ChannelAccountSnapshot = {
        accountId: "retrying",
        enabled: true,
        configured: true,
        running: false,
        connected: false,
        lifecycle: "recovering",
        restartPending: true,
        reconnectAttempts: 3,
        terminalDisconnect: false,
        lastStopAt: 2300,
        lastDisconnect: { at: 2200, error: "transport closed" },
        lastError: "waiting for restart",
      };
      const options = createOptions({});
      options.context.getRuntimeSnapshot = () => ({
        channels: { whatsapp: { accountId: listed ? "primary" : "default" } },
        channelAccounts: { whatsapp: { recovered, retrying } },
      });

      const payload = await runChannelsStatus({ probe }, { context: options.context });

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
        accountId: "recovered",
        enabled: true,
        configured: true,
        running: true,
        lifecycle: "starting",
        tokenSource: "config",
        tokenStatus: "available",
        stateReason: "admitted before configuration changed",
        lastStartAt: 1200,
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
      expect(accounts.find((account) => account.accountId === "retrying")).toMatchObject({
        running: false,
        connected: false,
        lifecycle: "recovering",
        restartPending: true,
        reconnectAttempts: 3,
        terminalDisconnect: false,
        lastStopAt: 2300,
        lastDisconnect: { at: 2200, error: "transport closed" },
        lastError: "waiting for restart",
      });
      expect(resolveAccount.mock.calls.map((call) => call[1])).not.toContain("recovered");
      expect(resolveAccount.mock.calls.map((call) => call[1])).not.toContain("retrying");
      expect(probeAccount).toHaveBeenCalledTimes(listed && probe ? 1 : 0);
      expect(auditAccount).toHaveBeenCalledTimes(listed && probe ? 1 : 0);
      expect(buildChannelSummary).toHaveBeenCalledTimes(listed ? 1 : 0);
      if (listed) {
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
    configureAutoEnabledChannels([
      createChannelPlugin({ id: "guildchat", collectStatusIssues: () => [policyIssue] }),
      createChannelPlugin({ id: "sibling" }),
    ]);
    mocks.buildChannelAccountSnapshotFromAccount.mockResolvedValue({
      accountId: "default",
      enabled: true,
      configured: true,
      running: true,
      connected: true,
      lastError: null,
    });
    const options = createOptions({});
    options.context.getDeferredChannelReloads = () => [
      { channel: "guildchat", publicationPending: true },
      { channel: "unselected", publicationPending: true },
    ];

    const payload = await runChannelsStatus({ channel: "guildchat" }, { context: options.context });

    expect(payload.statusIssues).toEqual([
      policyIssue,
      expect.objectContaining({
        channel: "guildchat",
        kind: "config",
        message: expect.stringContaining("previous configuration is still in use"),
        fix: expect.stringContaining("Stopping and starting the channel does not apply"),
      }),
    ]);
    expect(firstChannelAccount(payload, "guildchat")).toMatchObject({
      running: true,
      connected: true,
      lastError: null,
    });
    expect(payload.partial).toBeUndefined();
    expect(payload.warnings).toBeUndefined();
  });

  it("clears deferred diagnostics and distinguishes work after publication", async () => {
    const options = createOptions({});
    options.context.getDeferredChannelReloads = () => [
      { channel: "whatsapp", publicationPending: false },
    ];
    const payload = await runChannelsStatus({}, { context: options.context });
    expect(payload.statusIssues).toEqual([
      expect.objectContaining({
        message: "Channel reload is deferred while active work finishes.",
      }),
    ]);
    options.context.getDeferredChannelReloads = () => [];
    expect((await runChannelsStatus({}, { context: options.context })).statusIssues).toEqual([]);
  });

  it("retains account status when a plugin diagnostic collector fails", async () => {
    configureAutoEnabledChannels([
      createChannelPlugin({
        collectStatusIssues: () => {
          throw new Error("diagnostic unavailable");
        },
      }),
    ]);
    const payload = await runChannelsStatus({});
    expect(firstChannelAccount(payload, "whatsapp").configured).toBe(true);
    expect(payload.partial).toBe(true);
    expect(payload.warnings).toContain(
      "whatsapp status diagnostics failed: Error: diagnostic unavailable",
    );
  });

  it("redacts base URL credentials returned by channel summary hooks", async () => {
    configureAutoEnabledChannels([
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
    ]);

    const payload = await runChannelsStatus({ probe: false, timeoutMs: 2000 });
    const channels = requireGatewayRecord(payload.channels, "channels payload");
    const whatsapp = requireGatewayRecord(channels.whatsapp, "whatsapp channel");
    expect(whatsapp.baseUrl).toBe("https://chat.example.test/?token=***");
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
      configureAutoEnabledChannels([
        degraded,
        createChannelPlugin({ id: "healthy", probeAccount: healthyProbe }),
      ]);
      setActiveDegradedSecretOwners([
        {
          ownerKind: "account",
          ownerId: "degraded:default",
          state: "unavailable",
          degradationState,
          paths: ["channels.degraded.token"],
          refKeys: ["env:default:PRIVATE_TOKEN_REFERENCE"],
          reason: "secret reference was not found",
        },
      ]);

      const payload = await runChannelsStatus({ probe: true, timeoutMs: 1000 });

      expect(payload.partial).toBeUndefined();
      expect(firstChannelAccount(payload, "healthy").configured).toBe(true);
      expect(healthyProbe).toHaveBeenCalledOnce();
      if (degradationState === "cold") {
        expect(firstChannelAccount(payload, "degraded")).toMatchObject({
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
        expect(resolveAccount).not.toHaveBeenCalled();
        expect(probeAccount).not.toHaveBeenCalled();
        expect(buildChannelSummary).not.toHaveBeenCalled();
      } else {
        expect(resolveAccount).toHaveBeenCalledOnce();
        expect(probeAccount).toHaveBeenCalledOnce();
        expect(buildChannelSummary).toHaveBeenCalledOnce();
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
      configureAutoEnabledChannels([healthy]);
      failed.config.listAccountIds = () => ["default", "disabled"];
      mocks.applyPluginAutoEnable.mockReturnValue({
        config: {
          autoEnabled: true,
          logging: { redactSensitive: "off", redactPatterns: ["never-match-custom"] },
          channels: { "broken-channel": { accounts: { Disabled: { enabled: false } } } },
        },
        changes: [],
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

      const payload = await runChannelsStatus({ probe: true, timeoutMs: 1000 });

      expect(JSON.stringify(payload)).not.toContain(credential);
      const lastError = firstChannelAccount(payload, "broken-channel").lastError;
      expect(String(lastError).length).toBeLessThan(1200);
      expect(lastError).toContain("run openclaw doctor");
      expect(firstChannelAccount(payload, "broken-channel")).toMatchObject({
        configured: true,
        running: false,
        lifecycle: "blocked",
        lastError: expect.stringContaining("missing SDK export"),
      });
      expect(requireGatewayRecord(payload.channels, "channels")["broken-channel"]).toMatchObject({
        configured: true,
        lastError: expect.stringContaining("missing SDK export"),
      });
      const accounts = requireGatewayRecord(payload.channelAccounts, "accounts")["broken-channel"];
      expect(accounts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            accountId: "disabled",
            enabled: false,
            lastError: expect.stringContaining("missing SDK export"),
          }),
        ]),
      );
      expect(failedProbe).not.toHaveBeenCalled();
      expect(healthyProbe).toHaveBeenCalledOnce();
      mocks.normalizeChannelId.mockReturnValueOnce(null);
      const filtered = await runChannelsStatus({ channel: "broken-channel", probe: false });
      expect(firstChannelAccount(filtered, "broken-channel").lifecycle).toBe("blocked");
      expect(requireGatewayRecord(filtered.channelAccounts, "accounts")).not.toHaveProperty(
        "healthy",
      );
    },
  );

  it("caps probe timeout before passing it to channel plugins", async () => {
    const autoEnabledConfig = { autoEnabled: true };
    const probeAccount = vi.fn(async () => ({ ok: true }));
    mocks.applyPluginAutoEnable.mockReturnValue({ config: autoEnabledConfig, changes: [] });
    mocks.listChannelPlugins.mockReturnValue([createChannelPlugin({ probeAccount })]);

    await expectDefined(
      channelsHandlers["channels.status"],
      'channelsHandlers["channels.status"] test invariant',
    )(createOptions({ probe: true, timeoutMs: 999_999 }));

    const probeArgs = requireGatewayRecord(requireFirstCallArg(probeAccount), "probe args");
    expect(probeArgs.timeoutMs).toBe(30_000);
    expect(probeArgs.cfg).toBe(autoEnabledConfig);
  });

  it("runs channel probes concurrently and preserves deterministic status-map order", async () => {
    vi.useFakeTimers();
    try {
      const started: string[] = [];
      const createDelayedProbe = (id: string) => async () => {
        started.push(id);
        await new Promise((resolve) => {
          setTimeout(resolve, 1000);
        });
        return { ok: true };
      };
      configureAutoEnabledChannels([
        createChannelPlugin({ id: "zeta", probeAccount: createDelayedProbe("zeta") }),
        createChannelPlugin({ id: "alpha", probeAccount: createDelayedProbe("alpha") }),
      ]);
      mocks.buildChannelUiCatalog.mockImplementation((plugins: Array<{ id: string }>) => ({
        order: plugins.map((plugin) => plugin.id),
        labels: {},
        detailLabels: {},
        systemImages: {},
        entries: {},
      }));
      const startedAt = Date.now();
      const run = runChannelsStatus({ probe: true, timeoutMs: 2000 });

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
    } finally {
      vi.useRealTimers();
    }
  });

  it("filters channel status to a requested channel", async () => {
    const whatsappProbe = vi.fn(async () => ({ ok: true }));
    const imessageProbe = vi.fn(async () => ({ ok: true }));
    configureAutoEnabledChannels([
      createChannelPlugin({ id: "whatsapp", probeAccount: whatsappProbe }),
      createChannelPlugin({ id: "imessage", probeAccount: imessageProbe }),
    ]);
    mocks.buildChannelUiCatalog.mockImplementation((plugins: Array<{ id: string }>) => ({
      order: plugins.map((plugin) => plugin.id),
      labels: Object.fromEntries(plugins.map((plugin) => [plugin.id, plugin.id])),
      detailLabels: Object.fromEntries(plugins.map((plugin) => [plugin.id, plugin.id])),
      systemImages: {},
      entries: Object.fromEntries(plugins.map((plugin) => [plugin.id, { id: plugin.id }])),
    }));

    const payload = await runChannelsStatus({
      channel: "imessage",
      probe: true,
      timeoutMs: 1000,
    });

    expect(whatsappProbe).not.toHaveBeenCalled();
    expect(imessageProbe).toHaveBeenCalledOnce();
    expect(payload.channelOrder).toEqual(["imessage"]);
    expect(payload.channels).toEqual({
      imessage: { configured: true },
    });
    expect(payload.channelAccounts).toEqual({
      imessage: [
        {
          accountId: "default",
          configured: true,
          lastProbeAt: expect.any(Number),
          lastInboundAt: null,
          lastOutboundAt: null,
          healthState: "not-running",
        },
      ],
    });
  });

  it("preserves channel account rows when a live probe throws", async () => {
    const autoEnabledConfig = { autoEnabled: true };
    const probeAccount = vi.fn(async () => {
      throw new Error("probe failed");
    });
    mocks.applyPluginAutoEnable.mockReturnValue({ config: autoEnabledConfig, changes: [] });
    mocks.buildChannelAccountSnapshotFromAccount.mockImplementation(
      async ({ accountId, probe }) => ({
        accountId,
        configured: true,
        probe,
      }),
    );
    mocks.listChannelPlugins.mockReturnValue([createChannelPlugin({ probeAccount })]);

    const payload = await runChannelsStatus({ probe: true, timeoutMs: 1000 });

    const account = firstChannelAccount(payload, "whatsapp");
    expect(account.accountId).toBe("default");
    expect(String(account.lastError)).toContain("probe failed");
    expect(typeof account.lastProbeAt).toBe("number");
    const accountProbe = requireGatewayRecord(account.probe, "account probe");
    expect(accountProbe.ok).toBe(false);
    expect(String(accountProbe.error)).toContain("probe failed");
  });

  it("marks account snapshot failures partial", async () => {
    mocks.buildChannelAccountSnapshotFromAccount.mockRejectedValue(new Error("snapshot failed"));

    const payload = await runChannelsStatus({ probe: false, timeoutMs: 1000 });

    expect(payload.partial).toBe(true);
    expect(payload.warnings).toEqual(["whatsapp:default status failed: Error: snapshot failed"]);
    const channels = requireGatewayRecord(payload.channels, "channels payload");
    expect(channels.whatsapp).toEqual({ configured: false });
  });

  it("isolates a failed channel status task while a sibling succeeds", async () => {
    const broken = createChannelPlugin({ id: "broken" });
    broken.config.listAccountIds = () => {
      throw new Error("channel failed");
    };
    configureAutoEnabledChannels([broken, createChannelPlugin({ id: "healthy" })]);
    mocks.buildChannelUiCatalog.mockImplementation((plugins: Array<{ id: string }>) => ({
      order: plugins.map((plugin) => plugin.id),
      labels: {},
      detailLabels: {},
      systemImages: {},
      entries: {},
    }));

    const payload = await runChannelsStatus({ probe: false, timeoutMs: 1000 });

    expect(payload.partial).toBe(true);
    expect(payload.warnings).toEqual(["broken channel status failed: Error: channel failed"]);
    expect(requireGatewayRecord(payload.channels, "channels payload").healthy).toEqual({
      configured: true,
    });
  });

  it("isolates a timed-out channel probe while another channel succeeds", async () => {
    vi.useFakeTimers();
    try {
      const autoEnabledConfig = { autoEnabled: true };
      const hangingProbe = vi.fn(() => new Promise(() => {}));
      const healthyProbe = vi.fn(async () => ({ ok: true, identity: "healthy" }));
      mocks.applyPluginAutoEnable.mockReturnValue({ config: autoEnabledConfig, changes: [] });
      mocks.listChannelPlugins.mockReturnValue([
        createChannelPlugin({ id: "hanging", probeAccount: hangingProbe }),
        createChannelPlugin({ id: "healthy", probeAccount: healthyProbe }),
      ]);
      mocks.buildChannelAccountSnapshotFromAccount.mockImplementation(
        async ({ accountId, probe }) => ({
          accountId,
          configured: true,
          probe,
        }),
      );
      const respond = vi.fn();
      const run = expectDefined(
        channelsHandlers["channels.status"],
        'channelsHandlers["channels.status"] test invariant',
      )(createOptions({ probe: true, timeoutMs: 1000 }, { respond }));

      await vi.advanceTimersByTimeAsync(1000);
      await run;

      const payload = requireRespondPayload(respond);
      expect(
        requireGatewayRecord(firstChannelAccount(payload, "hanging").probe, "hanging probe")
          .timedOut,
      ).toBe(true);
      expect(
        requireGatewayRecord(firstChannelAccount(payload, "healthy").probe, "healthy probe"),
      ).toEqual({
        ok: true,
        identity: "healthy",
      });
      expect(payload.partial).toBe(true);
      expect(payload.warnings).toEqual(["hanging:default probe timed out after 1000ms"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to account-derived channel summaries when summary building fails", async () => {
    const autoEnabledConfig = { autoEnabled: true };
    mocks.applyPluginAutoEnable.mockReturnValue({ config: autoEnabledConfig, changes: [] });
    mocks.buildChannelAccountSnapshotFromAccount.mockResolvedValue({
      accountId: "default",
      configured: true,
    });
    mocks.listChannelPlugins.mockReturnValue([
      createChannelPlugin({
        buildChannelSummary: async () => {
          throw new Error("summary failed");
        },
      }),
    ]);

    const payload = await runChannelsStatus({ probe: false, timeoutMs: 1000 });
    const channels = requireGatewayRecord(payload.channels, "channels payload");
    const whatsapp = requireGatewayRecord(channels.whatsapp, "whatsapp channel");
    expect(whatsapp.configured).toBe(true);
    expect(String(whatsapp.lastError)).toContain("summary failed");

    const account = firstChannelAccount(payload, "whatsapp");
    expect(account.accountId).toBe("default");
    expect(account.configured).toBe(true);
  });

  it("annotates terminal-disconnect accounts with terminal-disconnect health state", async () => {
    mocks.applyPluginAutoEnable.mockReturnValue({ config: { autoEnabled: true }, changes: [] });
    mocks.buildChannelAccountSnapshotFromAccount.mockResolvedValue({
      accountId: "default",
      enabled: true,
      configured: true,
      running: false,
      terminalDisconnect: true,
    });
    const respond = vi.fn();

    await expectDefined(
      channelsHandlers["channels.status"],
      'channelsHandlers["channels.status"] test invariant',
    )(createOptions({ probe: false, timeoutMs: 2000 }, { respond }));

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        channelAccounts: {
          whatsapp: [
            expect.objectContaining({
              healthState: "terminal-disconnect",
            }),
          ],
        },
      }),
      undefined,
    );
  });

  it("annotates unhealthy channel snapshots and includes event-loop health", async () => {
    const now = Date.now();
    mocks.applyPluginAutoEnable.mockReturnValue({ config: { autoEnabled: true }, changes: [] });
    mocks.buildChannelAccountSnapshotFromAccount.mockResolvedValue({
      accountId: "default",
      enabled: true,
      configured: true,
      running: true,
      connected: true,
      healthState: "stale",
      lastStartAt: now - 60 * 60_000,
      lastTransportActivityAt: now - 40 * 60_000,
    });
    const eventLoop = {
      degraded: true,
      degradedSinceMs: 61_000,
      reasons: ["event_loop_delay"],
      intervalMs: 62_000,
      delayP99Ms: 62_000,
      delayMaxMs: 62_000,
      utilization: 1,
      cpuCoreRatio: 1,
    };
    const respond = vi.fn();

    await expectDefined(
      channelsHandlers["channels.status"],
      'channelsHandlers["channels.status"] test invariant',
    )(
      createOptions(
        { probe: false, timeoutMs: 2000 },
        {
          respond,
          context: {
            getRuntimeConfig: mocks.getRuntimeConfig,
            getRuntimeSnapshot: () => ({
              channels: {},
              channelAccounts: {},
            }),
            getEventLoopHealth: () => eventLoop,
          } as never,
        },
      ),
    );

    const payload = requireRespondPayload(respond);
    expect(payload.eventLoop).toBe(eventLoop);
    expect(firstChannelAccount(payload, "whatsapp").healthState).toBe("stale-socket");
  });

  it("preserves channel-authored health state when shared health is healthy", async () => {
    mocks.applyPluginAutoEnable.mockReturnValue({ config: { autoEnabled: true }, changes: [] });
    mocks.buildChannelAccountSnapshotFromAccount.mockResolvedValue({
      accountId: "default",
      enabled: true,
      configured: true,
      running: true,
      connected: true,
      healthState: "reconnecting",
    });

    const payload = await runChannelsStatus({ probe: false, timeoutMs: 2000 });

    expect(firstChannelAccount(payload, "whatsapp").healthState).toBe("reconnecting");
  });

  it("preserves channel-authored conflict when recorded blocked lifecycle is unhealthy", async () => {
    mocks.applyPluginAutoEnable.mockReturnValue({ config: { autoEnabled: true }, changes: [] });
    mocks.buildChannelAccountSnapshotFromAccount.mockResolvedValue({
      accountId: "default",
      enabled: true,
      configured: true,
      linked: true,
      running: false,
      connected: false,
      terminalDisconnect: true,
      lifecycle: "blocked",
      healthState: "conflict",
      lastError: "status=440",
    });

    const payload = await runChannelsStatus({ probe: false, timeoutMs: 2000 });

    expect(firstChannelAccount(payload, "whatsapp")).toMatchObject({
      lifecycle: "blocked",
      healthState: "conflict",
      terminalDisconnect: true,
    });
  });

  it("derives blocked health from recorded lifecycle", async () => {
    mocks.applyPluginAutoEnable.mockReturnValue({ config: { autoEnabled: true }, changes: [] });
    mocks.buildChannelAccountSnapshotFromAccount.mockResolvedValue({
      accountId: "default",
      enabled: true,
      configured: true,
      running: true,
      connected: true,
      lifecycle: "blocked",
      lastError: "Slack identity unavailable",
    });

    const payload = await runChannelsStatus({ probe: false, timeoutMs: 2000 });

    expect(firstChannelAccount(payload, "whatsapp")).toMatchObject({
      lifecycle: "blocked",
      healthState: "blocked",
    });
  });
});
