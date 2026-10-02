import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi } from "vitest";
import type { ChannelStatusIssue } from "../../channels/plugins/types.public.js";
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
        getRuntimeSnapshot: () => ({
          channels: {},
          channelAccounts: {},
        }),
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
