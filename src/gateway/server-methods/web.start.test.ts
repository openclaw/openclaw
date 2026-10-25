import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelRuntimeSnapshot } from "../server-channel-runtime.types.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  listChannelPlugins: vi.fn(),
  normalizeChannelId: vi.fn(),
  resolveMissingOfficialExternalChannelPluginRepairHints: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: mocks.listChannelPlugins,
  normalizeChannelId: mocks.normalizeChannelId,
}));

vi.mock("../../plugins/official-external-plugin-repair-hints.js", () => ({
  resolveMissingOfficialExternalChannelPluginRepairHints:
    mocks.resolveMissingOfficialExternalChannelPluginRepairHints,
}));

import { webHandlers } from "./web.js";

function createRunningWhatsappContext(
  channels: Record<string, { enabled: boolean }> = { whatsapp: { enabled: true } },
) {
  const cfg = { channels };
  const startChannel = vi.fn();
  const stopChannel = vi.fn();
  const account = { accountId: "default", running: true };
  const snapshot: ChannelRuntimeSnapshot = {
    channels: { whatsapp: account },
    channelAccounts: { whatsapp: { default: account } },
  };
  return {
    startChannel,
    stopChannel,
    context: {
      stopChannel,
      startChannel,
      getRuntimeSnapshot: vi.fn(() => snapshot),
      getRuntimeConfig: vi.fn(() => cfg),
      isConfigReloadSettled: () => true,
    } as unknown as GatewayRequestHandlerOptions["context"],
  };
}

async function invokeWeb(
  method: "web.login.start" | "web.login.wait",
  params: Record<string, unknown>,
  context = createRunningWhatsappContext().context,
) {
  const respond = vi.fn();
  await expectDefined(
    webHandlers[method],
    `${method} handler`,
  )({
    req: { type: "req", id: "request", method, params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context,
  });
  return respond;
}

function provider(
  gateway: Record<string, unknown>,
  id = "whatsapp",
  config: { listAccountIds: () => string[]; defaultAccountId?: () => string } = {
    listAccountIds: () => ["default"],
  },
) {
  const gatewayMethods = Object.keys(gateway).flatMap((key) =>
    key === "loginWithQrStart"
      ? ["web.login.start"]
      : key === "loginWithQrWait"
        ? ["web.login.wait"]
        : [],
  );
  return { id, config, gatewayMethods, gateway };
}

function expectInvalidRequest(respond: ReturnType<typeof vi.fn>, message?: unknown) {
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({
      code: "INVALID_REQUEST",
      ...(message === undefined ? {} : { message }),
    }),
  );
}

function startArgs(accountId: string) {
  return {
    accountId,
    force: false,
    timeoutMs: undefined,
    verbose: false,
    assertCredentialPersistenceCurrent: expect.any(Function),
  };
}

function missingPluginHint(channelId: string) {
  const installSpec = `clawhub:@openclaw/${channelId}`;
  const installCommand = `openclaw plugins install ${installSpec}`;
  const doctorFixCommand = "openclaw doctor --fix";
  return {
    pluginId: channelId,
    channelId,
    label: channelId === "whatsapp" ? "WhatsApp" : "Signal",
    installSpec,
    installCommand,
    doctorFixCommand,
    repairHint: `Install the official external plugin with: ${installCommand}, or run: ${doctorFixCommand}.`,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.normalizeChannelId.mockImplementation((channelId: string) =>
    channelId === "wechat" || channelId === "weixin" ? "openclaw-weixin" : channelId,
  );
  mocks.resolveMissingOfficialExternalChannelPluginRepairHints.mockReturnValue([]);
});

describe("webHandlers web.login.start", () => {
  it.each([
    [
      ["whatsapp"],
      "Install the official external plugin with: openclaw plugins install clawhub:@openclaw/whatsapp, or run: openclaw doctor --fix.",
    ],
    [
      ["whatsapp", "signal"],
      "Configured official external channel plugins are missing for WhatsApp, Signal. Install them with: openclaw plugins install clawhub:@openclaw/whatsapp; openclaw plugins install clawhub:@openclaw/signal, or run: openclaw doctor --fix.",
    ],
  ] as const)("surfaces repair hints for missing providers %j", async (channelIds, hint) => {
    mocks.listChannelPlugins.mockReturnValue([]);
    mocks.resolveMissingOfficialExternalChannelPluginRepairHints.mockImplementation(
      ({ channelIds: requested }: { channelIds: string[] }) =>
        requested
          .filter((id) => channelIds.some((channel) => channel === id))
          .map(missingPluginHint),
    );
    const channels = Object.fromEntries(channelIds.map((id) => [id, { enabled: true }]));
    const respond = await invokeWeb(
      "web.login.start",
      { accountId: "default" },
      createRunningWhatsappContext(channels).context,
    );
    expectInvalidRequest(respond, `web login provider is not available. ${hint}`);
    expect(mocks.resolveMissingOfficialExternalChannelPluginRepairHints).toHaveBeenCalledWith({
      config: { channels },
      channelIds,
    });
  });

  it.each([
    [false, false, false, false],
    [false, true, true, false],
    [true, false, true, true],
  ])(
    "running channel lifecycle: force=%s QR=%s stop=%s restart=%s",
    async (force, qr, stopsChannel, restartsChannel) => {
      const result = qr
        ? { qrDataUrl: "data:image/png;base64,qr", message: "scan qr" }
        : { code: "whatsapp-auth-unstable", message: "retry later" };
      const loginWithQrStart = vi.fn().mockResolvedValue(result);
      mocks.listChannelPlugins.mockReturnValue([provider({ loginWithQrStart })]);
      const { context, startChannel, stopChannel } = createRunningWhatsappContext();
      const respond = await invokeWeb("web.login.start", { accountId: "default", force }, context);

      expect({ stop: stopChannel.mock.calls, start: startChannel.mock.calls }).toEqual({
        stop: stopsChannel ? [["whatsapp", "default"]] : [],
        start: restartsChannel ? [["whatsapp", "default"]] : [],
      });
      expect(respond).toHaveBeenCalledWith(true, result, undefined);
    },
  );

  it("preserves gateway method receiver state for login start", async () => {
    const result = { connected: true, message: "gateway-state" };
    const gateway = {
      marker: "gateway-state",
      async loginWithQrStart(this: { marker: string }) {
        return { ...result, message: this.marker };
      },
    };
    const loginWithQrStart = vi.spyOn(gateway, "loginWithQrStart");
    mocks.listChannelPlugins.mockReturnValue([provider(gateway)]);
    const respond = await invokeWeb("web.login.start", { accountId: "default" });

    expect(loginWithQrStart).toHaveBeenCalledWith(startArgs("default"));
    expect(respond).toHaveBeenCalledWith(true, result, undefined);
  });

  it("routes the explicit WeChat alias to its QR-login provider", async () => {
    const whatsappLogin = vi.fn();
    const weixinLogin = vi.fn().mockResolvedValue({
      message: "scan in WeChat",
      qrDataUrl: "data:image/png;base64,weixin-qr",
      sessionKey: "weixin-session",
    });
    mocks.listChannelPlugins.mockReturnValue([
      provider({ loginWithQrStart: whatsappLogin, loginWithQrWait: vi.fn() }),
      provider({ loginWithQrStart: weixinLogin, loginWithQrWait: vi.fn() }, "openclaw-weixin"),
    ]);
    const respond = await invokeWeb("web.login.start", { channel: "wechat", accountId: "work" });

    expect(whatsappLogin).not.toHaveBeenCalled();
    expect(weixinLogin).toHaveBeenCalledWith(startArgs("work"));
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ sessionKey: "weixin-session" }),
      undefined,
    );
  });

  it("does not fall back to the first provider for an unknown channel", async () => {
    const whatsappLogin = vi.fn();
    mocks.listChannelPlugins.mockReturnValue([provider({ loginWithQrStart: whatsappLogin })]);
    const respond = await invokeWeb("web.login.start", { channel: "missing-channel" });

    expect(whatsappLogin).not.toHaveBeenCalled();
    expectInvalidRequest(respond);
  });

  it.each(["web.login.start", "web.login.wait"] as const)(
    "%s rejects an ambiguous account before plugin or listener effects",
    async (method) => {
      const login = vi.fn();
      mocks.listChannelPlugins.mockReturnValue([
        {
          ...provider({ loginWithQrStart: login, loginWithQrWait: login }, "whatsapp", {
            listAccountIds: () => ["account-a", "account-b"],
          }),
          gatewayMethods: [method],
        },
      ]);
      const { context, stopChannel, startChannel } = createRunningWhatsappContext();
      const respond = await invokeWeb(method, {}, context);

      expectInvalidRequest(respond, expect.stringMatching(/accountId.*account-a, account-b/));
      expect(login).not.toHaveBeenCalled();
      expect(stopChannel).not.toHaveBeenCalled();
      expect(startChannel).not.toHaveBeenCalled();
    },
  );

  it("revokes deferred credential writes when the account configuration changes", async () => {
    let persist: (() => void) | undefined;
    const writeCredentials = vi.fn();
    mocks.listChannelPlugins.mockReturnValue([
      provider(
        {
          loginWithQrStart: async (params: { assertCredentialPersistenceCurrent: () => void }) => {
            persist = () => {
              params.assertCredentialPersistenceCurrent();
              writeCredentials();
            };
            return { qrDataUrl: "data:image/png;base64,QQ==" };
          },
        },
        "whatsapp",
        { listAccountIds: () => ["account-a", "account-b"] },
      ),
    ]);
    const { context } = createRunningWhatsappContext();
    await invokeWeb("web.login.start", { accountId: "account-b" }, context);
    expectDefined(persist, "credential writer")();
    vi.mocked(context.getRuntimeConfig).mockReturnValue({ channels: {} });

    expect(() => expectDefined(persist, "credential writer")()).toThrow("changed during login");
    expect(writeCredentials).toHaveBeenCalledOnce();
  });

  it("keeps an omitted account omitted for the plugin so environment-selected profiles survive", async () => {
    const loginWithQrStart = vi.fn().mockResolvedValue({ qrDataUrl: "data:image/png;base64,QQ==" });
    mocks.listChannelPlugins.mockReturnValue([
      provider({ loginWithQrStart }, "zalouser", {
        listAccountIds: () => ["work"],
        defaultAccountId: () => "work",
      }),
    ]);
    const { context, stopChannel } = createRunningWhatsappContext();
    await invokeWeb("web.login.start", { channel: "zalouser" }, context);

    expect(loginWithQrStart).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: undefined }),
    );
    expect(stopChannel).toHaveBeenCalledWith("zalouser", "work");
  });

  it("keeps the legacy first-provider fallback when channel is omitted", async () => {
    const whatsappLogin = vi.fn().mockResolvedValue({ message: "whatsapp" });
    const weixinLogin = vi.fn();
    mocks.listChannelPlugins.mockReturnValue([
      provider({ loginWithQrStart: whatsappLogin }),
      provider({ loginWithQrStart: weixinLogin }, "openclaw-weixin"),
    ]);
    await invokeWeb("web.login.start", {});

    expect(whatsappLogin).toHaveBeenCalled();
    expect(weixinLogin).not.toHaveBeenCalled();
  });
});

describe("webHandlers web.login.wait", () => {
  it("passes refreshed QR payloads back to the client while login is still pending", async () => {
    const result = {
      connected: false,
      message: "QR refreshed. Scan the latest code in WhatsApp → Linked Devices.",
      qrDataUrl: "data:image/png;base64,next-qr",
    };
    const loginWithQrWait = vi.fn().mockResolvedValue(result);
    mocks.listChannelPlugins.mockReturnValue([provider({ loginWithQrWait })]);
    const respond = await invokeWeb("web.login.wait", {
      accountId: "default",
      timeoutMs: 5000,
      currentQrDataUrl: "data:image/png;base64,current-qr",
    });

    expect(loginWithQrWait).toHaveBeenCalledWith({
      accountId: "default",
      timeoutMs: 5000,
      currentQrDataUrl: "data:image/png;base64,current-qr",
      sessionKey: undefined,
    });
    expect(respond).toHaveBeenCalledWith(true, result, undefined);
  });

  it("routes and correlates the explicit Weixin alias login session", async () => {
    const whatsappWait = vi.fn();
    const weixinWait = vi.fn().mockResolvedValue({ connected: true, message: "connected" });
    mocks.listChannelPlugins.mockReturnValue([
      provider({ loginWithQrStart: vi.fn(), loginWithQrWait: whatsappWait }),
      provider({ loginWithQrStart: vi.fn(), loginWithQrWait: weixinWait }, "openclaw-weixin"),
    ]);
    await invokeWeb("web.login.wait", {
      channel: "weixin",
      accountId: "work",
      sessionKey: "weixin-session",
    });

    expect(whatsappWait).not.toHaveBeenCalled();
    expect(weixinWait).toHaveBeenCalledWith({
      accountId: "work",
      timeoutMs: undefined,
      currentQrDataUrl: undefined,
      sessionKey: "weixin-session",
    });
  });
});
