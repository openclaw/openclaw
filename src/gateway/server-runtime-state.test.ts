import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getChannelPlugin } from "../channels/plugins/index.js";
import {
  releasePinnedPluginChannelRegistry,
  releasePinnedPluginHttpRouteRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createGatewayRuntimeState } from "./server-runtime-state.js";

const hoisted = vi.hoisted(() => ({
  attachGatewayUpgradeHandler: vi.fn(),
  createGatewayHooksRequestHandler: vi.fn(() => vi.fn()),
  createGatewayHttpServer: vi.fn(),
  createGatewayPluginRequestHandler: vi.fn(() => vi.fn(async () => false)),
  listenGatewayHttpServer: vi.fn(async () => {}),
  resolveGatewayListenHosts: vi.fn(async (bindHost: string) => [bindHost]),
  shouldEnforceGatewayAuthForPluginPath: vi.fn(() => false),
}));

vi.mock("./net.js", () => ({
  isLoopbackHost: () => true,
  resolveGatewayListenHosts: hoisted.resolveGatewayListenHosts,
}));

vi.mock("./server-http.js", () => ({
  attachGatewayUpgradeHandler: hoisted.attachGatewayUpgradeHandler,
  createGatewayHttpServer: hoisted.createGatewayHttpServer,
}));

vi.mock("./server/http-listen.js", () => ({
  listenGatewayHttpServer: hoisted.listenGatewayHttpServer,
}));

vi.mock("./server/hooks.js", () => ({
  createGatewayHooksRequestHandler: hoisted.createGatewayHooksRequestHandler,
}));

vi.mock("./server/plugins-http.js", () => ({
  createGatewayPluginRequestHandler: hoisted.createGatewayPluginRequestHandler,
  shouldEnforceGatewayAuthForPluginPath: hoisted.shouldEnforceGatewayAuthForPluginPath,
}));

describe("createGatewayRuntimeState", () => {
  afterEach(() => {
    releasePinnedPluginChannelRegistry();
    releasePinnedPluginHttpRouteRegistry();
    resetPluginRuntimeStateForTest();
    vi.clearAllMocks();
  });

  it("pins the startup channel registry until the gateway runtime releases it", async () => {
    hoisted.createGatewayHttpServer.mockImplementation(() => createServer());

    const startupRegistry = createTestRegistry([
      {
        pluginId: "telegram",
        plugin: createOutboundTestPlugin({
          id: "telegram",
          outbound: {
            deliveryMode: "direct",
            sendText: async () => ({ channel: "telegram", messageId: "telegram-msg" }),
          },
        }),
        source: "test",
      },
    ]);
    const laterRegistry = createTestRegistry([]);
    setActivePluginRegistry(startupRegistry, "gateway-startup-registry");

    const runtimeState = await createGatewayRuntimeState({
      cfg: {},
      bindHost: "127.0.0.1",
      port: 18789,
      controlUiEnabled: false,
      controlUiBasePath: "/",
      openAiChatCompletionsEnabled: false,
      openResponsesEnabled: false,
      resolvedAuth: {} as never,
      hooksConfig: () => null,
      getHookClientIpConfig: () => ({}) as never,
      pluginRegistry: startupRegistry,
      deps: {} as never,
      canvasRuntime: {} as never,
      canvasHostEnabled: false,
      logCanvas: { info: vi.fn(), warn: vi.fn() },
      log: { info: vi.fn(), warn: vi.fn() },
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      logPlugins: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    });

    setActivePluginRegistry(laterRegistry, "gateway-later-registry");

    expect(getChannelPlugin("telegram")?.id).toBe("telegram");

    runtimeState.releasePluginRouteRegistry();

    expect(getChannelPlugin("telegram")).toBeUndefined();

    runtimeState.wss.close();
  });
});
