import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi } from "vitest";
import type { ChannelAccountSnapshot, ChannelPlugin } from "../../channels/plugins/types.public.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import type { GatewayEventLoopHealth } from "../server/event-loop-health.js";
import { requireGatewayRecord } from "../test-helpers.assertions.js";
import type { GatewayRequestHandler, GatewayRequestHandlerOptions } from "./types.js";

type ChannelTestPlugin = Pick<ChannelPlugin<Record<string, never>>, "id" | "config" | "status">;
type StatusPayload = Record<string, unknown>;
type StatusContext = GatewayRequestHandlerOptions["context"];

export function createChannelPlugin({
  id = "whatsapp",
  ...status
}: { id?: string } & ChannelTestPlugin["status"] = {}): ChannelTestPlugin {
  return {
    id,
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({}),
      isEnabled: () => true,
      isConfigured: () => true,
    },
    ...(Object.keys(status).length ? { status } : {}),
  };
}

export function createChannelDeadlineFixture(step: string, synchronous: boolean) {
  const expire = () => {
    vi.setSystemTime(Date.now() + 1000);
    return {};
  };
  const overrun = async () => {
    if (!synchronous) {
      await new Promise<never>(() => {});
    }
    return expire();
  };
  const plugin: ChannelPlugin = createChannelTestPluginBase({ id: "hanging" });
  const describeAccount = vi.fn(() => ({ accountId: "default" }));
  plugin.config.resolveAccount = step === "resolve" && synchronous ? expire : () => ({});
  plugin.config.resolveAccountAsync = step === "resolve" && !synchronous ? overrun : undefined;
  plugin.config.isConfigured =
    step === "configured" ? async () => Boolean(await overrun()) : () => true;
  plugin.config.describeAccount = describeAccount;
  plugin.status = {
    probeAccount: step === "probe" ? overrun : async () => ({ ok: true }),
    auditAccount: step === "audit" ? overrun : undefined,
    buildChannelSummary: step === "summary" ? overrun : undefined,
    buildAccountSnapshot: async ({ runtime, probe }) => {
      if (step === "snapshot") {
        await overrun();
      }
      return { ...runtime, accountId: "default", probe };
    },
  };
  return { plugin, describeAccount };
}

export function createRecordedHealthFixture() {
  const unavailable = vi.fn(() => {
    throw new Error("live status unavailable");
  });
  const channelIds = ["slack", "discord", "telegram", "x", "matrix", "whatsapp"];
  const plugins = channelIds.map((id) => ({
    ...createChannelPlugin({ id, probeAccount: unavailable, buildChannelSummary: unavailable }),
    config: {
      ...createChannelPlugin().config,
      resolveAccount: unavailable,
      resolveAccountAsync: unavailable,
      inspectAccount: () => ({ enabled: true, configured: true }),
    },
  }));
  return { channelIds, plugins, unavailable };
}

export function createQueuedSummaryFixture() {
  const summary = vi.fn(() => ({ configured: true }));
  const plugin = createChannelPlugin({ id: "beta" });
  plugin.status = {
    get buildChannelSummary() {
      void Promise.resolve().then(() => vi.setSystemTime(Date.now() + 1000));
      return summary;
    },
  };
  return { summary, plugins: [plugin] };
}

export function channelAccounts(payload: StatusPayload, channel: string) {
  const accounts = requireGatewayRecord(payload.channelAccounts, "channel accounts")[
    channel
  ] as unknown[];
  expect(Array.isArray(accounts)).toBe(true);
  return accounts.map((account) => requireGatewayRecord(account, "channel account"));
}

export const firstAccount = (payload: StatusPayload, channel = "whatsapp") =>
  expectDefined(channelAccounts(payload, channel)[0], "first channel account");

export const firstCallArgs = (mock: { mock: { calls: readonly (readonly unknown[])[] } }) =>
  requireGatewayRecord(mock.mock.calls[0]?.[0], "first mock arguments");

export function createChannelsStatusHarness(options: {
  handler: GatewayRequestHandler;
  getRuntimeConfig: StatusContext["getRuntimeConfig"];
  getRuntimeSnapshot: StatusContext["getRuntimeSnapshot"];
}) {
  return async (params: StatusPayload, context: Partial<StatusContext> = {}) => {
    const respond = vi.fn();
    await options.handler({
      req: { type: "req", id: "req-1", method: "channels.status", params },
      params,
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {
        getRuntimeConfig: options.getRuntimeConfig,
        getRuntimeSnapshot: options.getRuntimeSnapshot,
        ...context,
      },
    } as unknown as GatewayRequestHandlerOptions);
    const call = expectDefined(respond.mock.calls[0], "Expected respond call");
    expect(call[0]).toBe(true);
    expect(call[2]).toBeUndefined();
    return requireGatewayRecord(call[1], "respond payload");
  };
}

export function createRecordedAccountSnapshots() {
  const common = { enabled: true, configured: true };
  const recoveredFacts: ChannelAccountSnapshot = {
    ...common,
    accountId: "recovered",
    running: true,
    lifecycle: "starting",
    tokenSource: "config",
    tokenStatus: "available",
    stateReason: "admitted before configuration changed",
    lastStartAt: 1200,
    lastError: null,
  };
  const recovered: ChannelAccountSnapshot = {
    ...recoveredFacts,
    baseUrl: "https://runtime-user:runtime-password@chat.example.test/?token=runtime-token",
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
    ...common,
    accountId: "retrying",
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
  return { recovered, recoveredFacts, retrying };
}

export function buildChannelTestUiCatalog(plugins: Array<{ id: string }>) {
  return {
    order: plugins.map((plugin) => plugin.id),
    labels: Object.fromEntries(plugins.map((plugin) => [plugin.id, plugin.id])),
    detailLabels: {},
    systemImages: {},
    entries: Object.fromEntries(plugins.map((plugin) => [plugin.id, { id: plugin.id }])),
  };
}

export const RECORDED_CHANNEL_HEALTH_CASES = [
  { snapshot: { running: false, terminalDisconnect: true }, healthState: "terminal-disconnect" },
  { snapshot: { healthState: "reconnecting" }, healthState: "reconnecting" },
  {
    snapshot: {
      running: false,
      connected: false,
      terminalDisconnect: true,
      lifecycle: "blocked" as const,
      healthState: "conflict",
      lastError: "status=440",
    },
    healthState: "conflict",
  },
  {
    snapshot: { lifecycle: "blocked" as const, lastError: "Slack identity unavailable" },
    healthState: "blocked",
  },
  {
    snapshot: {
      healthState: "stale",
      lastStartAt: Date.now() - 60 * 60_000,
      lastTransportActivityAt: Date.now() - 40 * 60_000,
    },
    healthState: "stale-socket",
  },
];

export const DEGRADED_EVENT_LOOP_HEALTH: GatewayEventLoopHealth = {
  degraded: true,
  degradedSinceMs: 61_000,
  reasons: ["event_loop_delay"],
  intervalMs: 62_000,
  delayP99Ms: 62_000,
  delayMaxMs: 62_000,
  utilization: 1,
  cpuCoreRatio: 1,
};
