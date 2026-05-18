import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelRuntimeSnapshot } from "../server-channel-runtime.types.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
  readConfigFileSnapshot: vi.fn(),
  applyPluginAutoEnable: vi.fn(),
  getChannelPlugin: vi.fn(),
  normalizeChannelId: vi.fn<(value: string) => string | null>((value: string) => value),
  normalizeChatChannelId: vi.fn<(value: string) => string | null>(() => null),
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: mocks.applyPluginAutoEnable,
}));

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: vi.fn(),
  getChannelPlugin: mocks.getChannelPlugin,
  normalizeChannelId: mocks.normalizeChannelId,
}));

vi.mock("../../channels/ids.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../channels/ids.js")>()),
  normalizeChatChannelId: mocks.normalizeChatChannelId,
}));

import { channelsHandlers } from "./channels.js";

function createOptions(
  params: Record<string, unknown>,
  overrides?: Partial<GatewayRequestHandlerOptions>,
): GatewayRequestHandlerOptions {
  return {
    req: { type: "req", id: "req-1", method: "channels.start", params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: {
      getRuntimeConfig: mocks.getRuntimeConfig,
      startChannel: vi.fn(),
      stopChannel: vi.fn(),
      markChannelLoggedOut: vi.fn(),
      getRuntimeSnapshot: vi.fn(
        (): ChannelRuntimeSnapshot => ({
          channels: {
            whatsapp: {
              accountId: "default-account",
              running: true,
            },
          },
          channelAccounts: {
            whatsapp: {
              "default-account": {
                accountId: "default-account",
                running: true,
              },
            },
          },
        }),
      ),
    },
    ...overrides,
  } as unknown as GatewayRequestHandlerOptions;
}

describe("channelsHandlers channels.start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRuntimeConfig.mockReturnValue({ channels: { whatsapp: {} } });
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({ config, changes: [] }));
    mocks.normalizeChannelId.mockImplementation((value: string) => value);
    mocks.normalizeChatChannelId.mockImplementation(() => null);
    mocks.getChannelPlugin.mockReturnValue({
      id: "whatsapp",
      gateway: { startAccount: vi.fn() },
      config: {
        defaultAccountId: () => "default-account",
        listAccountIds: () => ["default-account"],
        resolveAccount: () => ({}),
      },
    });
  });

  it("reports missing channel config before trying to start the runtime", async () => {
    const startChannel = vi.fn();
    const respond = vi.fn();
    mocks.getRuntimeConfig.mockReturnValue({ channels: {} });

    await channelsHandlers["channels.start"](
      createOptions(
        { channel: "whatsapp" },
        {
          respond,
          context: {
            getRuntimeConfig: mocks.getRuntimeConfig,
            startChannel,
            getRuntimeSnapshot: vi.fn(
              (): ChannelRuntimeSnapshot => ({ channels: {}, channelAccounts: {} }),
            ),
          } as unknown as GatewayRequestHandlerOptions["context"],
        },
      ),
    );

    expect(startChannel).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message:
          "Channel whatsapp is not configured. Add channels.whatsapp to your config before starting it.",
      }),
    );
  });

  it("rejects auto-enabled channel config that is missing from the runtime config", async () => {
    const startChannel = vi.fn();
    const respond = vi.fn();
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.applyPluginAutoEnable.mockReturnValue({
      config: { channels: { whatsapp: {} } },
      changes: ["whatsapp"],
    });

    await channelsHandlers["channels.start"](
      createOptions(
        { channel: "whatsapp" },
        {
          respond,
          context: {
            getRuntimeConfig: mocks.getRuntimeConfig,
            startChannel,
            getRuntimeSnapshot: vi.fn(
              (): ChannelRuntimeSnapshot => ({ channels: {}, channelAccounts: {} }),
            ),
          } as unknown as GatewayRequestHandlerOptions["context"],
        },
      ),
    );

    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith({
      config: {},
      env: process.env,
    });
    expect(startChannel).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message:
          "Channel whatsapp is not configured. Add channels.whatsapp to your config before starting it.",
      }),
    );
  });

  it("reports unknown channel before suggesting config for an unloaded plugin", async () => {
    const respond = vi.fn();
    mocks.normalizeChannelId.mockReturnValueOnce(null);
    mocks.normalizeChatChannelId.mockReturnValueOnce("whatsapp");
    mocks.getChannelPlugin.mockReturnValueOnce(undefined);
    mocks.getRuntimeConfig.mockReturnValue({ channels: {} });

    await channelsHandlers["channels.start"](createOptions({ channel: "whatsapp" }, { respond }));

    expect(mocks.getChannelPlugin).toHaveBeenCalledWith("whatsapp");
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "unknown channel: whatsapp",
      }),
    );
  });

  it("resolves the default account and starts the channel runtime", async () => {
    const startChannel = vi.fn();
    const respond = vi.fn();

    await channelsHandlers["channels.start"](
      createOptions(
        { channel: "whatsapp" },
        {
          respond,
          context: {
            getRuntimeConfig: mocks.getRuntimeConfig,
            startChannel,
            getRuntimeSnapshot: vi.fn(
              (): ChannelRuntimeSnapshot => ({
                channels: {
                  whatsapp: {
                    accountId: "default-account",
                    running: true,
                  },
                },
                channelAccounts: {
                  whatsapp: {
                    "default-account": {
                      accountId: "default-account",
                      running: true,
                    },
                  },
                },
              }),
            ),
          } as unknown as GatewayRequestHandlerOptions["context"],
        },
      ),
    );

    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith({
      config: { channels: { whatsapp: {} } },
      env: process.env,
    });
    expect(startChannel).toHaveBeenCalledWith("whatsapp", "default-account");
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        channel: "whatsapp",
        accountId: "default-account",
        started: true,
      },
      undefined,
    );
  });

  it("reports started=false when the channel runtime remains stopped", async () => {
    const startChannel = vi.fn();
    const respond = vi.fn();

    await channelsHandlers["channels.start"](
      createOptions(
        { channel: "whatsapp" },
        {
          respond,
          context: {
            getRuntimeConfig: mocks.getRuntimeConfig,
            startChannel,
            getRuntimeSnapshot: vi.fn(
              (): ChannelRuntimeSnapshot => ({
                channels: {
                  whatsapp: {
                    accountId: "default-account",
                    running: false,
                  },
                },
                channelAccounts: {
                  whatsapp: {
                    "default-account": {
                      accountId: "default-account",
                      running: false,
                    },
                  },
                },
              }),
            ),
          } as unknown as GatewayRequestHandlerOptions["context"],
        },
      ),
    );

    expect(startChannel).toHaveBeenCalledWith("whatsapp", "default-account");
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        channel: "whatsapp",
        accountId: "default-account",
        started: false,
      },
      undefined,
    );
  });
});

describe("channelsHandlers channels.stop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.getChannelPlugin.mockReturnValue({
      id: "whatsapp",
      config: {
        defaultAccountId: () => "default-account",
        listAccountIds: () => ["default-account"],
        resolveAccount: () => ({}),
      },
    });
  });

  it("stops a channel account without clearing auth state", async () => {
    const stopChannel = vi.fn(async () => undefined);
    const respond = vi.fn();

    await channelsHandlers["channels.stop"](
      createOptions(
        { channel: "whatsapp" },
        {
          respond,
          context: {
            getRuntimeConfig: mocks.getRuntimeConfig,
            stopChannel,
            getRuntimeSnapshot: vi.fn(
              (): ChannelRuntimeSnapshot => ({
                channels: {},
                channelAccounts: {
                  whatsapp: {
                    "default-account": {
                      accountId: "default-account",
                      running: false,
                    },
                  },
                },
              }),
            ),
          } as unknown as GatewayRequestHandlerOptions["context"],
        },
      ),
    );

    expect(stopChannel).toHaveBeenCalledWith("whatsapp", "default-account");
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        channel: "whatsapp",
        accountId: "default-account",
        stopped: true,
      },
      undefined,
    );
  });
});

describe("channelsHandlers channels.logout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      config: {
        channels: {
          whatsapp: {
            token: { source: "env", provider: "default", id: "WHATSAPP_TOKEN" },
          },
        },
      },
    });
  });

  it("passes the active runtime config to channel plugins", async () => {
    const runtimeConfig = {
      channels: {
        whatsapp: {
          token: "runtime-token",
        },
      },
    };
    const stopChannel = vi.fn();
    const markChannelLoggedOut = vi.fn();
    const logoutAccount = vi.fn(async ({ cfg }: { cfg: typeof runtimeConfig }) => {
      expect(cfg.channels.whatsapp.token).toBe("runtime-token");
      return { cleared: true, envToken: false, loggedOut: true };
    });
    const respond = vi.fn();
    mocks.getRuntimeConfig.mockReturnValue(runtimeConfig);
    mocks.getChannelPlugin.mockReturnValue({
      id: "whatsapp",
      gateway: { logoutAccount },
      config: {
        defaultAccountId: () => "default-account",
        listAccountIds: () => ["default-account"],
        resolveAccount: () => ({}),
      },
    });

    await channelsHandlers["channels.logout"](
      createOptions(
        { channel: "whatsapp" },
        {
          respond,
          context: {
            getRuntimeConfig: mocks.getRuntimeConfig,
            stopChannel,
            markChannelLoggedOut,
          } as unknown as GatewayRequestHandlerOptions["context"],
        },
      ),
    );

    expect(stopChannel).toHaveBeenCalledWith("whatsapp", "default-account");
    expect(markChannelLoggedOut).toHaveBeenCalledWith("whatsapp", true, "default-account");
    expect(logoutAccount).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        channel: "whatsapp",
        accountId: "default-account",
        cleared: true,
        envToken: false,
        loggedOut: true,
      },
      undefined,
    );
  });
});
