import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelRuntimeSnapshot } from "../server-channel-runtime.types.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  listChannelPlugins: vi.fn(),
  resolveMissingOfficialExternalChannelPluginRepairHint: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: mocks.listChannelPlugins,
}));

vi.mock("../../plugins/official-external-plugin-repair-hints.js", () => ({
  resolveMissingOfficialExternalChannelPluginRepairHint:
    mocks.resolveMissingOfficialExternalChannelPluginRepairHint,
}));

import { webHandlers } from "./web.js";

function createOptions(
  params: Record<string, unknown>,
  overrides?: Partial<GatewayRequestHandlerOptions>,
): GatewayRequestHandlerOptions {
  return {
    req: { type: "req", id: "req-1", method: "web.login.start", params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: {
      getRuntimeConfig: vi.fn().mockReturnValue({}),
      stopChannel: vi.fn(),
      startChannel: vi.fn(),
      getRuntimeSnapshot: vi.fn(
        (): ChannelRuntimeSnapshot => ({
          channels: {
            whatsapp: {
              accountId: "default",
              running: true,
            },
          },
          channelAccounts: {
            whatsapp: {
              default: {
                accountId: "default",
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

function createRunningWhatsappContext() {
  const startChannel = vi.fn();
  const stopChannel = vi.fn();
  return {
    startChannel,
    stopChannel,
    context: {
      getRuntimeConfig: vi.fn().mockReturnValue({}),
      stopChannel,
      startChannel,
      getRuntimeSnapshot: vi.fn(
        (): ChannelRuntimeSnapshot => ({
          channels: {
            whatsapp: {
              accountId: "default",
              running: true,
            },
          },
          channelAccounts: {
            whatsapp: {
              default: {
                accountId: "default",
                running: true,
              },
            },
          },
        }),
      ),
    } as unknown as GatewayRequestHandlerOptions["context"],
  };
}

describe("webHandlers web.login.start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveMissingOfficialExternalChannelPluginRepairHint.mockImplementation(
      ({ channelId }: { channelId: string }) =>
        channelId === "whatsapp"
          ? {
              pluginId: "whatsapp",
              channelId: "whatsapp",
              label: "WhatsApp",
              installSpec: "clawhub:@openclaw/whatsapp",
              installCommand: "openclaw plugins install clawhub:@openclaw/whatsapp",
              doctorFixCommand: "openclaw doctor --fix",
              repairHint:
                "Install the official external plugin with: openclaw plugins install clawhub:@openclaw/whatsapp, or run: openclaw doctor --fix.",
            }
          : null,
    );
  });

  it("restarts a previously running channel when login start exits early without a QR", async () => {
    const loginWithQrStart = vi.fn().mockResolvedValue({
      code: "whatsapp-auth-unstable",
      message: "retry later",
    });
    mocks.listChannelPlugins.mockReturnValue([
      {
        id: "whatsapp",
        gatewayMethods: ["web.login.start"],
        gateway: { loginWithQrStart },
      },
    ]);
    const { context, startChannel, stopChannel } = createRunningWhatsappContext();
    const respond = vi.fn();

    await webHandlers["web.login.start"](
      createOptions(
        { accountId: "default" },
        {
          respond,
          context,
        },
      ),
    );

    expect(stopChannel).toHaveBeenCalledWith("whatsapp", "default");
    expect(startChannel).toHaveBeenCalledWith("whatsapp", "default");
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        code: "whatsapp-auth-unstable",
        message: "retry later",
      },
      undefined,
    );
  });

  it("keeps the channel stopped when login start has taken over with a QR flow", async () => {
    const loginWithQrStart = vi.fn().mockResolvedValue({
      qrDataUrl: "data:image/png;base64,qr",
      message: "scan qr",
    });
    mocks.listChannelPlugins.mockReturnValue([
      {
        id: "whatsapp",
        gatewayMethods: ["web.login.start"],
        gateway: { loginWithQrStart },
      },
    ]);
    const { context, startChannel, stopChannel } = createRunningWhatsappContext();

    await webHandlers["web.login.start"](
      createOptions(
        { accountId: "default" },
        {
          context,
        },
      ),
    );

    expect(stopChannel).toHaveBeenCalledWith("whatsapp", "default");
    expect(startChannel).not.toHaveBeenCalled();
  });

  it("explains how to repair a configured missing external WhatsApp plugin", async () => {
    mocks.listChannelPlugins.mockReturnValue([]);
    const respond = vi.fn();

    await webHandlers["web.login.start"](
      createOptions(
        { accountId: "default" },
        {
          respond,
          context: {
            getRuntimeConfig: vi.fn().mockReturnValue({
              channels: { whatsapp: { enabled: true } },
            }),
            stopChannel: vi.fn(),
            startChannel: vi.fn(),
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

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("openclaw plugins install clawhub:@openclaw/whatsapp"),
      }),
    );
  });

  it("does not guess missing-plugin repair hints when channel policy suppresses them", async () => {
    mocks.listChannelPlugins.mockReturnValue([]);
    mocks.resolveMissingOfficialExternalChannelPluginRepairHint.mockReturnValueOnce(null);
    const respond = vi.fn();

    await webHandlers["web.login.start"](
      createOptions(
        { accountId: "default" },
        {
          respond,
          context: {
            getRuntimeConfig: vi.fn().mockReturnValue({
              channels: { whatsapp: { enabled: true } },
            }),
            stopChannel: vi.fn(),
            startChannel: vi.fn(),
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

    expect(mocks.resolveMissingOfficialExternalChannelPluginRepairHint).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: "whatsapp" }),
    );
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "web login provider is not available",
      }),
    );
  });
});

describe("webHandlers web.login.wait", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveMissingOfficialExternalChannelPluginRepairHint.mockImplementation(
      ({ channelId }: { channelId: string }) =>
        channelId === "whatsapp"
          ? {
              pluginId: "whatsapp",
              channelId: "whatsapp",
              label: "WhatsApp",
              installSpec: "clawhub:@openclaw/whatsapp",
              installCommand: "openclaw plugins install clawhub:@openclaw/whatsapp",
              doctorFixCommand: "openclaw doctor --fix",
              repairHint:
                "Install the official external plugin with: openclaw plugins install clawhub:@openclaw/whatsapp, or run: openclaw doctor --fix.",
            }
          : null,
    );
  });

  it("passes refreshed QR payloads back to the client while login is still pending", async () => {
    const loginWithQrWait = vi.fn().mockResolvedValue({
      connected: false,
      message: "QR refreshed. Scan the latest code in WhatsApp → Linked Devices.",
      qrDataUrl: "data:image/png;base64,next-qr",
    });
    mocks.listChannelPlugins.mockReturnValue([
      {
        id: "whatsapp",
        gatewayMethods: ["web.login.wait"],
        gateway: { loginWithQrWait },
      },
    ]);
    const respond = vi.fn();

    await webHandlers["web.login.wait"](
      createOptions(
        {
          accountId: "default",
          timeoutMs: 5000,
          currentQrDataUrl: "data:image/png;base64,current-qr",
        },
        {
          req: {
            type: "req",
            id: "req-2",
            method: "web.login.wait",
            params: {
              accountId: "default",
              timeoutMs: 5000,
              currentQrDataUrl: "data:image/png;base64,current-qr",
            },
          } as GatewayRequestHandlerOptions["req"],
          respond,
        },
      ),
    );

    expect(loginWithQrWait).toHaveBeenCalledWith({
      accountId: "default",
      timeoutMs: 5000,
      currentQrDataUrl: "data:image/png;base64,current-qr",
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        connected: false,
        message: "QR refreshed. Scan the latest code in WhatsApp → Linked Devices.",
        qrDataUrl: "data:image/png;base64,next-qr",
      },
      undefined,
    );
  });

  it("uses the same missing external plugin repair hint while waiting", async () => {
    mocks.listChannelPlugins.mockReturnValue([]);
    const respond = vi.fn();

    await webHandlers["web.login.wait"](
      createOptions(
        { accountId: "default" },
        {
          req: {
            type: "req",
            id: "req-2",
            method: "web.login.wait",
            params: { accountId: "default" },
          } as GatewayRequestHandlerOptions["req"],
          respond,
          context: {
            getRuntimeConfig: vi.fn().mockReturnValue({
              channels: { whatsapp: { enabled: true } },
            }),
            stopChannel: vi.fn(),
            startChannel: vi.fn(),
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

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("openclaw doctor --fix"),
      }),
    );
  });
});
