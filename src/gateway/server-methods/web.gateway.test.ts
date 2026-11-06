import { afterEach, describe, expect, it, vi } from "vitest";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  authorizationClient,
  dispatchAuthorizationRequest as dispatch,
} from "../server-methods.authorization.test-support.js";
import { createRequestGatewayMethodRegistry } from "../server-methods.js";
import type { GatewayRequestContext } from "./types.js";

afterEach(resetPluginRuntimeStateForTest);

const startParams = {
  accountId: undefined,
  force: false,
  timeoutMs: undefined,
  verbose: false,
  assertCredentialPersistenceCurrent: expect.any(Function),
};

function registryEntry(
  id: string,
  start: ReturnType<typeof vi.fn>,
  wait?: ReturnType<typeof vi.fn>,
  aliases: string[] = [],
) {
  return {
    pluginId: id,
    source: "test",
    plugin: {
      id,
      config: { listAccountIds: () => ["default"] },
      meta: { aliases },
      gatewayMethods: wait ? ["web.login.start", "web.login.wait"] : ["web.login.start"],
      gateway: { loginWithQrStart: start, ...(wait ? { loginWithQrWait: wait } : {}) },
    },
  };
}

function requestContext(withLogger = false) {
  const cfg = {};
  return {
    getRuntimeConfig: () => cfg,
    isConfigReloadSettled: () => true,
    getRuntimeSnapshot: () => ({ channels: {}, channelAccounts: {} }),
    stopChannel: vi.fn(),
    startChannel: vi.fn(),
    ...(withLogger ? { logGateway: { warn: vi.fn(), debug: vi.fn() } } : {}),
  } as unknown as GatewayRequestContext;
}

describe("web QR login Gateway dispatch", () => {
  it("routes an alias and forwards the opaque session key through the Gateway", async () => {
    const weixinStart = vi.fn().mockResolvedValue({ sessionKey: "opaque-session" });
    const weixinWait = vi.fn().mockResolvedValue({ connected: true, message: "connected" });
    const whatsappStart = vi.fn();
    const whatsappWait = vi.fn();
    setActivePluginRegistry(
      createTestRegistry([
        registryEntry("whatsapp", whatsappStart, whatsappWait),
        registryEntry("openclaw-weixin", weixinStart, weixinWait, ["weixin", "wechat"]),
      ]),
    );
    const context = requestContext(true);
    const client = authorizationClient(
      "conn-test",
      ["operator.admin"],
      {},
      {
        client: { id: "cli", version: "test", platform: "test", mode: "cli" },
      },
    );

    const options = { context, client };
    const startRespond = await dispatch("web.login.start", { channel: "wechat" }, options);
    const waitRespond = await dispatch(
      "web.login.wait",
      {
        channel: "weixin",
        sessionKey: "opaque-session",
      },
      options,
    );

    expect(whatsappStart).not.toHaveBeenCalled();
    expect(whatsappWait).not.toHaveBeenCalled();
    expect(weixinStart).toHaveBeenCalledWith(startParams);
    expect(weixinWait).toHaveBeenCalledWith({
      accountId: undefined,
      timeoutMs: undefined,
      sessionKey: "opaque-session",
      currentQrDataUrl: undefined,
    });
    expect(startRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ sessionKey: "opaque-session" }),
      undefined,
    );
    expect(waitRespond).toHaveBeenCalledWith(
      true,
      { connected: true, message: "connected" },
      undefined,
    );
  });

  it("routes explicit selectors through the registry attached to the request", async () => {
    const globalWhatsappStart = vi.fn();
    const scopedWeixinStart = vi.fn().mockResolvedValue({ connected: true });
    const globalRegistry = createTestRegistry([registryEntry("whatsapp", globalWhatsappStart)]);
    const scopedRegistry = createTestRegistry([
      registryEntry("openclaw-weixin", scopedWeixinStart, undefined, ["wechat"]),
    ]);
    setActivePluginRegistry(globalRegistry);
    const methodRegistry = {
      ...createRequestGatewayMethodRegistry(),
      pluginRegistry: scopedRegistry,
    };
    const respond = await dispatch(
      "web.login.start",
      { channel: "wechat" },
      {
        methodRegistry,
        client: null,
        context: requestContext(),
      },
      "scoped",
    );

    expect(globalWhatsappStart).not.toHaveBeenCalled();
    expect(scopedWeixinStart).toHaveBeenCalledWith(startParams);
    expect(respond).toHaveBeenCalledWith(true, { connected: true }, undefined);
  });
});
