import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { GatewayRequestHandlerOptions } from "./shared-types.js";

const hoisted = vi.hoisted(() => ({
  listChannelPlugins: vi.fn<() => ChannelPlugin[]>(() => []),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: hoisted.listChannelPlugins,
}));

import { webHandlers } from "./web.js";

function createWebLoginPlugin(
  gateway: NonNullable<ChannelPlugin["gateway"]>,
): ChannelPlugin<Record<string, never>> {
  return {
    id: "whatsapp",
    meta: {
      id: "whatsapp",
      label: "WhatsApp",
      selectionLabel: "WhatsApp",
      docsPath: "/whatsapp",
      blurb: "WhatsApp",
    },
    capabilities: {
      chatTypes: ["direct"],
    },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({}),
    },
    gatewayMethods: ["web.login.start", "web.login.wait"],
    gateway,
  };
}

function createHandlerOptions(params: {
  respond: GatewayRequestHandlerOptions["respond"];
  stopChannel: (channelId: string, accountId?: string) => Promise<void>;
  startChannel?: (channelId: string, accountId?: string) => Promise<void>;
}): GatewayRequestHandlerOptions {
  return {
    req: {
      id: "req_1",
      method: "web.login.start",
    } as never,
    params: {},
    client: null,
    isWebchatConnect: () => false,
    respond: params.respond,
    context: {
      getRuntimeSnapshot: () => ({
        channels: {},
        channelAccounts: {},
      }),
      startChannel: params.startChannel ?? (async () => undefined),
      stopChannel: params.stopChannel,
    } as never,
  };
}

describe("webHandlers", () => {
  beforeEach(() => {
    hoisted.listChannelPlugins.mockReset().mockReturnValue([]);
  });

  it("does not stop the channel when QR login preflight returns unstable auth", async () => {
    const stopChannel = vi.fn(async () => undefined);
    const respond = vi.fn();
    const loginWithQrStart = vi.fn(async () => ({
      qrDataUrl: "data:image/png;base64,qr",
      message: "Scan this QR in WhatsApp -> Linked Devices.",
    }));
    const loginWithQrStartPreflight = vi.fn(async () => ({
      code: "whatsapp-auth-unstable",
      message: "WhatsApp auth state is still stabilizing. Retry login in a moment.",
    }));
    hoisted.listChannelPlugins.mockReturnValue([
      createWebLoginPlugin({
        loginWithQrStart,
        loginWithQrStartPreflight,
      }),
    ]);

    await webHandlers["web.login.start"](
      createHandlerOptions({
        respond,
        stopChannel,
      }),
    );

    expect(loginWithQrStartPreflight).toHaveBeenCalledOnce();
    expect(stopChannel).not.toHaveBeenCalled();
    expect(loginWithQrStart).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        code: "whatsapp-auth-unstable",
        message: "WhatsApp auth state is still stabilizing. Retry login in a moment.",
      },
      undefined,
    );
  });

  it("stops the channel before starting QR login when preflight allows it", async () => {
    const stopChannel = vi.fn(async () => undefined);
    const respond = vi.fn();
    const loginWithQrStart = vi.fn(async () => ({
      qrDataUrl: "data:image/png;base64,qr",
      message: "Scan this QR in WhatsApp -> Linked Devices.",
    }));
    const loginWithQrStartPreflight = vi.fn(async () => null);
    hoisted.listChannelPlugins.mockReturnValue([
      createWebLoginPlugin({
        loginWithQrStart,
        loginWithQrStartPreflight,
      }),
    ]);

    await webHandlers["web.login.start"](
      createHandlerOptions({
        respond,
        stopChannel,
      }),
    );

    expect(loginWithQrStartPreflight).toHaveBeenCalledOnce();
    expect(stopChannel).toHaveBeenCalledWith("whatsapp", undefined);
    expect(loginWithQrStart).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        qrDataUrl: "data:image/png;base64,qr",
        message: "Scan this QR in WhatsApp -> Linked Devices.",
      },
      undefined,
    );
  });
});
