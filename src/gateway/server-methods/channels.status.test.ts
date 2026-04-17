import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
  applyPluginAutoEnable: vi.fn(),
  listChannelPlugins: vi.fn(),
  buildChannelUiCatalog: vi.fn(),
  buildChannelAccountSnapshot: vi.fn(),
  getChannelActivity: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
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
  normalizeChannelId: (value: string) => value,
}));

vi.mock("../../channels/plugins/catalog.js", () => ({
  buildChannelUiCatalog: mocks.buildChannelUiCatalog,
}));

vi.mock("../../channels/plugins/status.js", () => ({
  buildChannelAccountSnapshot: mocks.buildChannelAccountSnapshot,
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
      getRuntimeSnapshot: () => ({
        channels: {},
        channelAccounts: {},
      }),
    },
    ...overrides,
  } as unknown as GatewayRequestHandlerOptions;
}

describe("channelsHandlers channels.status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfig.mockReturnValue({});
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({ config, changes: [] }));
    mocks.buildChannelUiCatalog.mockReturnValue({
      order: ["whatsapp"],
      labels: { whatsapp: "WhatsApp" },
      detailLabels: { whatsapp: "WhatsApp" },
      systemImages: { whatsapp: undefined },
      entries: { whatsapp: { id: "whatsapp" } },
    });
    mocks.buildChannelAccountSnapshot.mockResolvedValue({
      accountId: "default",
      configured: true,
    });
    mocks.getChannelActivity.mockReturnValue({
      inboundAt: null,
      outboundAt: null,
    });
    mocks.listChannelPlugins.mockReturnValue([
      {
        id: "whatsapp",
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
          isEnabled: () => true,
          isConfigured: async (_account: unknown, cfg: { autoEnabled?: boolean }) =>
            Boolean(cfg.autoEnabled),
        },
      },
    ]);
  });

  it("uses the auto-enabled config snapshot for channel account state", async () => {
    const autoEnabledConfig = { autoEnabled: true };
    mocks.applyPluginAutoEnable.mockReturnValue({ config: autoEnabledConfig, changes: [] });
    const respond = vi.fn();
    const opts = createOptions(
      { probe: false, timeoutMs: 2000 },
      {
        respond,
      },
    );

    await channelsHandlers["channels.status"](opts);

    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith({
      config: {},
      env: process.env,
    });
    expect(mocks.buildChannelAccountSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: autoEnabledConfig,
        accountId: "default",
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        channels: {
          whatsapp: expect.objectContaining({
            configured: true,
          }),
        },
      }),
      undefined,
    );
  });

  it("probes channels concurrently while preserving account order", async () => {
    vi.useFakeTimers();
    try {
      const respond = vi.fn();
      mocks.listChannelPlugins.mockReturnValue([
        {
          id: "whatsapp",
          config: {
            listAccountIds: () => ["alpha", "beta"],
            resolveAccount: (_cfg: unknown, accountId: string) => ({ accountId }),
            isEnabled: () => true,
            isConfigured: async () => true,
          },
          status: {
            probeAccount: async ({ account }: { account: { accountId: string } }) => {
              await new Promise((resolve) => setTimeout(resolve, 1_000));
              return { ok: true, probeFor: account.accountId };
            },
            auditAccount: async ({
              account,
              probe,
            }: {
              account: { accountId: string };
              probe?: { probeFor?: string };
            }) => {
              await new Promise((resolve) => setTimeout(resolve, 1_000));
              return { ok: true, auditFor: account.accountId, sawProbeFor: probe?.probeFor };
            },
          },
        },
        {
          id: "telegram",
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: (_cfg: unknown, accountId: string) => ({ accountId }),
            isEnabled: () => true,
            isConfigured: async () => true,
          },
          status: {
            probeAccount: async ({ account }: { account: { accountId: string } }) => {
              await new Promise((resolve) => setTimeout(resolve, 1_000));
              return { ok: true, probeFor: account.accountId };
            },
          },
        },
      ]);
      mocks.buildChannelUiCatalog.mockReturnValue({
        order: ["whatsapp", "telegram"],
        labels: { whatsapp: "WhatsApp", telegram: "Telegram" },
        detailLabels: { whatsapp: "WhatsApp", telegram: "Telegram" },
        systemImages: { whatsapp: undefined, telegram: undefined },
        entries: { whatsapp: { id: "whatsapp" }, telegram: { id: "telegram" } },
      });
      mocks.buildChannelAccountSnapshot.mockImplementation(
        async ({
          accountId,
          probe,
          audit,
        }: {
          accountId: string;
          probe?: unknown;
          audit?: unknown;
        }) => ({
          accountId,
          configured: true,
          probe,
          audit,
        }),
      );

      const request = channelsHandlers["channels.status"](
        createOptions(
          { probe: true, timeoutMs: 2_000 },
          {
            respond,
          },
        ),
      );

      await vi.advanceTimersByTimeAsync(1_999);
      expect(respond).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await request;

      expect(respond).toHaveBeenCalledTimes(1);
      const payload = respond.mock.calls[0]?.[1] as {
        channelAccounts: {
          whatsapp: Array<{ accountId: string; audit?: { sawProbeFor?: string } }>;
          telegram: Array<{ accountId: string; probe?: { probeFor?: string } }>;
        };
      };
      expect(payload.channelAccounts.whatsapp.map((entry) => entry.accountId)).toEqual([
        "alpha",
        "beta",
      ]);
      expect(payload.channelAccounts.whatsapp.map((entry) => entry.audit?.sawProbeFor)).toEqual([
        "alpha",
        "beta",
      ]);
      expect(payload.channelAccounts.telegram[0]?.probe?.probeFor).toBe("default");
    } finally {
      vi.useRealTimers();
    }
  });
});
