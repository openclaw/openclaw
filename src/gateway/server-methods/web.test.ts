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
  running?: boolean;
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
        channels: params.running ? { whatsapp: { running: true } } : {},
        channelAccounts: {},
      }),
      startChannel: params.startChannel ?? (async () => undefined),
      stopChannel: params.stopChannel,
    } as never,
  };
}

async function startWebLogin(options: GatewayRequestHandlerOptions): Promise<void> {
  const handler = webHandlers["web.login.start"];
  if (!handler) {
    throw new Error("web.login.start handler is not registered");
  }
  await handler(options);
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

    await startWebLogin(
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

  it("rejects a QR-bearing preflight without starting login again", async () => {
    const events: string[] = [];
    const stopChannel = vi.fn(async () => {
      events.push("stop");
    });
    const startChannel = vi.fn(async () => {
      events.push("start-channel");
    });
    const respond = vi.fn(() => {
      events.push("respond");
    });
    const loginWithQrStart = vi.fn(async () => {
      return {
        qrDataUrl: "data:image/png;base64,active-qr",
        message: "QR already active. Scan it in WhatsApp -> Linked Devices.",
      };
    });
    const loginWithQrStartPreflight = vi.fn(async () => {
      events.push("preflight");
      return {
        qrDataUrl: "data:image/png;base64,preflight-qr",
        message: "QR already active. Scan it in WhatsApp -> Linked Devices.",
      };
    });
    const plugin = createWebLoginPlugin({
      loginWithQrStart,
      loginWithQrStartPreflight: async () => null,
    });
    const gateway = plugin.gateway;
    if (!gateway) {
      throw new Error("web login test plugin is missing its gateway adapter");
    }
    // Simulate a JavaScript plugin that bypasses the TypeScript contract.
    Object.defineProperty(gateway, "loginWithQrStartPreflight", {
      value: loginWithQrStartPreflight,
    });
    hoisted.listChannelPlugins.mockReturnValue([plugin]);

    await startWebLogin(
      createHandlerOptions({
        respond,
        stopChannel,
        startChannel,
        running: true,
      }),
    );

    expect(loginWithQrStartPreflight).toHaveBeenCalledOnce();
    expect(loginWithQrStart).not.toHaveBeenCalled();
    expect(stopChannel).not.toHaveBeenCalled();
    expect(startChannel).not.toHaveBeenCalled();
    expect(events).toEqual(["preflight", "respond"]);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: expect.stringContaining("login preflight must not return QR data"),
      }),
    );
  });

  it("stops a running channel after the start path returns an active QR", async () => {
    const events: string[] = [];
    const stopChannel = vi.fn(async () => {
      events.push("stop");
    });
    const respond = vi.fn(() => {
      events.push("respond");
    });
    const loginWithQrStart = vi.fn(async () => {
      events.push("start");
      return {
        qrDataUrl: "data:image/png;base64,existing-qr",
        message: "QR already active. Scan it in WhatsApp -> Linked Devices.",
      };
    });
    const loginWithQrStartPreflight = vi.fn(async () => null);
    hoisted.listChannelPlugins.mockReturnValue([
      createWebLoginPlugin({
        loginWithQrStart,
        loginWithQrStartPreflight,
      }),
    ]);

    await startWebLogin(
      createHandlerOptions({
        respond,
        stopChannel,
        running: true,
      }),
    );

    expect(loginWithQrStartPreflight).toHaveBeenCalledOnce();
    expect(loginWithQrStart).toHaveBeenCalledOnce();
    expect(stopChannel).toHaveBeenCalledWith("whatsapp", undefined);
    expect(events).toEqual(["start", "stop", "respond"]);
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        qrDataUrl: "data:image/png;base64,existing-qr",
        message: "QR already active. Scan it in WhatsApp -> Linked Devices.",
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

    await startWebLogin(
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
