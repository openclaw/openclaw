import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi } from "vitest";
import type {
  ChannelAccountSnapshot,
  ChannelPlugin,
  ChannelStatusIssue,
} from "../../channels/plugins/types.public.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import { requireGatewayRecord } from "../test-helpers.assertions.js";
import type { GatewayRequestHandler, GatewayRequestHandlerOptions } from "./types.js";

type ChannelTestPlugin = {
  id: string;
  config: {
    listAccountIds: () => string[];
    resolveAccount: () => Record<string, never>;
    isEnabled: () => boolean;
    isConfigured: () => boolean;
  };
  status?: {
    probeAccount?: (params?: unknown) => unknown;
    buildChannelSummary?: () => unknown;
    collectStatusIssues?: () => ChannelStatusIssue[];
  };
};

export function createChannelPlugin(
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
      isConfigured: () => true,
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
      void Promise.resolve().then(() => {
        vi.setSystemTime(Date.now() + 1000);
      });
      return summary;
    },
  };
  return { summary, plugins: [plugin] };
}

export function channelAccounts(
  payload: Record<string, unknown>,
  channel: string,
): Record<string, unknown>[] {
  const accounts = requireGatewayRecord(payload.channelAccounts, "channel accounts")[
    channel
  ] as unknown[];
  expect(Array.isArray(accounts)).toBe(true);
  return accounts.map((account) => requireGatewayRecord(account, "channel account"));
}

export function firstChannelAccount(
  payload: Record<string, unknown>,
  channel: string,
): Record<string, unknown> {
  return expectDefined(
    channelAccounts(payload, channel)[0],
    "channelAccounts(payload, channel)[0] test invariant",
  );
}

export function requireFirstCallArg(mock: { mock: { calls: readonly (readonly unknown[])[] } }) {
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

export function createChannelsStatusHarness(options: {
  handler: GatewayRequestHandler;
  getRuntimeConfig: GatewayRequestHandlerOptions["context"]["getRuntimeConfig"];
  getRuntimeSnapshot?: GatewayRequestHandlerOptions["context"]["getRuntimeSnapshot"];
}) {
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
        getRuntimeConfig: options.getRuntimeConfig,
        getRuntimeSnapshot:
          options.getRuntimeSnapshot ??
          (() => ({
            channels: {},
            channelAccounts: {},
          })),
      },
      ...overrides,
    } as unknown as GatewayRequestHandlerOptions;
  }

  async function runChannelsStatus(
    params: Record<string, unknown>,
    overrides?: Partial<GatewayRequestHandlerOptions>,
  ) {
    const respond = vi.fn();
    await options.handler(createOptions(params, { respond, ...overrides }));
    return requireRespondPayload(respond);
  }

  return { createOptions, runChannelsStatus };
}

export function createRecordedAccountSnapshots() {
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
  return { recovered, retrying };
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
