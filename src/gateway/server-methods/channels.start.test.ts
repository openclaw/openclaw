import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelRuntimeSnapshot } from "../server-channel-runtime.types.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
  readConfigFileSnapshot: vi.fn(),
  applyPluginAutoEnable: vi.fn(),
  getChannelPlugin: vi.fn(),
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
  normalizeChannelId: (value: string) => value,
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
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({ config, changes: [] }));
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
      config: {},
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
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({ config, changes: [] }));
    mocks.getChannelPlugin.mockReturnValue({
      id: "whatsapp",
      gateway: { startAccount: vi.fn(), logoutAccount: vi.fn() },
      config: {
        defaultAccountId: () => "default-account",
        listAccountIds: () => ["default-account"],
        resolveAccount: () => ({}),
      },
    });
  });

  it("stops the channel runtime without logging out or clearing credentials", async () => {
    const stopChannel = vi.fn();
    const logoutAccount = vi.fn();
    const respond = vi.fn();
    mocks.getChannelPlugin.mockReturnValue({
      id: "whatsapp",
      gateway: { startAccount: vi.fn(), logoutAccount },
      config: {
        defaultAccountId: () => "default-account",
        listAccountIds: () => ["default-account"],
        resolveAccount: () => ({}),
      },
    });

    await channelsHandlers["channels.stop"](
      createOptions(
        { channel: "whatsapp", accountId: "acct-1" },
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
                    "acct-1": {
                      accountId: "acct-1",
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

    expect(stopChannel).toHaveBeenCalledWith("whatsapp", "acct-1");
    expect(logoutAccount).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        channel: "whatsapp",
        accountId: "acct-1",
        stopped: true,
      },
      undefined,
    );
  });

  it("reports an actionable error when the plugin has no lifecycle stop support", async () => {
    const respond = vi.fn();
    mocks.getChannelPlugin.mockReturnValue({
      id: "whatsapp",
      gateway: {},
      config: {
        defaultAccountId: () => "default-account",
        listAccountIds: () => ["default-account"],
        resolveAccount: () => ({}),
      },
    });

    await channelsHandlers["channels.stop"](createOptions({ channel: "whatsapp" }, { respond }));

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "channel whatsapp does not support runtime stop",
      }),
    );
  });

  it("uses the existing validation error style for invalid params", async () => {
    const respond = vi.fn();

    await channelsHandlers["channels.stop"](createOptions({ channel: "" }, { respond }));

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("invalid channels.stop params"),
      }),
    );
  });

  it("does not stop when the requested account cannot be resolved", async () => {
    const stopChannel = vi.fn();
    const respond = vi.fn();
    mocks.getChannelPlugin.mockReturnValue({
      id: "whatsapp",
      gateway: { startAccount: vi.fn() },
      config: {
        defaultAccountId: () => "default-account",
        listAccountIds: () => ["default-account"],
        resolveAccount: vi.fn(() => {
          throw new Error("unknown account");
        }),
      },
    });

    await channelsHandlers["channels.stop"](
      createOptions(
        { channel: "whatsapp", accountId: "missing" },
        {
          respond,
          context: {
            getRuntimeConfig: mocks.getRuntimeConfig,
            stopChannel,
            getRuntimeSnapshot: vi.fn(
              (): ChannelRuntimeSnapshot => ({
                channels: {},
                channelAccounts: {},
              }),
            ),
          } as unknown as GatewayRequestHandlerOptions["context"],
        },
      ),
    );

    expect(stopChannel).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("unknown account"),
      }),
    );
  });
});

describe("channelsHandlers channels.restart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({ config, changes: [] }));
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

  it("stops then starts the channel account in order", async () => {
    const calls: string[] = [];
    const stopChannel = vi.fn(async () => {
      calls.push("stop");
    });
    const startChannel = vi.fn(async () => {
      calls.push("start");
    });
    const respond = vi.fn();
    let running = false;

    await channelsHandlers["channels.restart"](
      createOptions(
        { channel: "whatsapp", accountId: "acct-1" },
        {
          respond,
          context: {
            getRuntimeConfig: mocks.getRuntimeConfig,
            stopChannel,
            startChannel,
            getRuntimeSnapshot: vi.fn((): ChannelRuntimeSnapshot => {
              const snapshot = {
                channels: {},
                channelAccounts: {
                  whatsapp: {
                    "acct-1": {
                      accountId: "acct-1",
                      running,
                    },
                  },
                },
              };
              running = true;
              return snapshot;
            }),
          } as unknown as GatewayRequestHandlerOptions["context"],
        },
      ),
    );

    expect(calls).toEqual(["stop", "start"]);
    expect(stopChannel).toHaveBeenCalledWith("whatsapp", "acct-1");
    expect(startChannel).toHaveBeenCalledWith("whatsapp", "acct-1");
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        channel: "whatsapp",
        accountId: "acct-1",
        stopped: true,
        started: true,
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
