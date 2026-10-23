import { afterEach, expect, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import type { GatewayEventFrame } from "../api/gateway.ts";
import { mountView } from "../components/mcp-app-view.test-support.ts";
import { i18n } from "../i18n/index.ts";
import { createApplicationGateway } from "./application-context-fixtures.ts";
import { createGatewayRequestMock, createTestGatewayClient } from "./gateway-client.ts";
import { gatewayHelloForMethods } from "./gateway-methods.ts";

type TextContent = Array<{ type: string; text?: string }>;
type ModelContext = { content?: TextContent; structuredContent?: Record<string, unknown> };
type MockBridge = {
  capabilities: Record<string, unknown>;
  options: { hostContext?: Record<string, unknown> };
  messageHandler?: (params: {
    role: "user";
    content: TextContent;
  }) => Promise<{ isError?: boolean }>;
  updateModelContextHandler?: (params: ModelContext) => Promise<Record<string, never>>;
  onsizechange?: (params: { height?: number }) => void;
  onopenlink?: (params: { url: string }) => Promise<{ isError?: boolean }>;
  onrequestdisplaymode?: (params: { mode: "inline" | "fullscreen" }) => Promise<{ mode: string }>;
  setHostContext: ReturnType<typeof vi.fn>;
  teardownResource: ReturnType<typeof vi.fn>;
  emit(type: string): void;
};

export function createMcpBridgeFixture(bridgeMocks: {
  instances: Array<Record<string, unknown>>;
  transports: Array<Record<string, unknown>>;
  appModes: string[] | undefined;
}) {
  afterEach(async () => {
    bridgeMocks.instances.length = 0;
    bridgeMocks.transports.length = 0;
    bridgeMocks.appModes = undefined;
    document.body.replaceChildren();
    delete (document as unknown as Record<string, unknown>).activeElement;
    delete document.documentElement.dataset.themeMode;
    document.documentElement.style.removeProperty("--card");
    document.documentElement.style.removeProperty("--text");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await i18n.setLocale("en");
  });

  return async function mountBridge(
    viewId: string,
    messageSupported = true,
    updateModelContextSupported = messageSupported,
    payload: Record<string, unknown> = {},
  ) {
    vi.spyOn(HTMLIFrameElement.prototype, "contentWindow", "get").mockReturnValue(window);
    const frameReady = deferred<HTMLIFrameElement>();
    const frameSource = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "src")!;
    vi.spyOn(HTMLIFrameElement.prototype, "src", "set").mockImplementation(function (
      this: HTMLIFrameElement,
      value,
    ) {
      frameSource.set!.call(this, value);
      frameReady.resolve(this);
    });
    const themeListeners = new Set<() => void>();
    const gatewayListeners = new Set<(event: GatewayEventFrame) => void>();
    const gatewayEventsReady = deferred();
    const gatewayEventsStopped = deferred();
    const unsubscribe = vi.fn();
    const request = createGatewayRequestMock(() =>
      Promise.resolve({
        sandboxUrl: "/mcp-app-sandbox?ticket=test",
        sandboxPort: 8444,
        html: "<!doctype html><button>Send</button>",
        toolInput: {},
        toolResult: { content: [{ type: "text", text: "ready" }] },
        messageSupported,
        updateModelContextSupported,
        state: null,
        ...payload,
      }),
    );
    const { gateway, publish } = createApplicationGateway();
    publish({
      ...gateway.snapshot,
      client: createTestGatewayClient(request),
      phase: "connected",
      hello: gatewayHelloForMethods(["mcp.app.view"]),
    });
    Object.assign(gateway, {
      connection: { gatewayUrl: "ws://gateway.example:8443/openclaw" },
      subscribeEvents(listener: (event: GatewayEventFrame) => void) {
        gatewayListeners.add(listener);
        gatewayEventsReady.resolve();
        return () => {
          gatewayListeners.delete(listener);
          if (gatewayListeners.size === 0) {
            gatewayEventsStopped.resolve();
          }
        };
      },
    });
    const { view, unmount } = mountView(
      { sessionKey: "agent:main:main", viewId, title: "Parts library" },
      {
        gateway,
        theme: {
          subscribe(listener: () => void) {
            themeListeners.add(listener);
            return () => {
              themeListeners.delete(listener);
              unsubscribe();
            };
          },
        },
      },
    );

    const frame = await frameReady.promise;
    expect(frame.getAttribute("src")).toContain("/mcp-app-sandbox?ticket=test");
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { method: "ui/notifications/sandbox-proxy-ready" },
        source: frame.contentWindow,
      }),
    );
    await gatewayEventsReady.promise;
    expect(bridgeMocks.instances).toHaveLength(1);
    return {
      // SAFETY: the shared AppBridge mock records the instance with these handlers.
      bridge: bridgeMocks.instances[0] as MockBridge,
      frame,
      request,
      gateway,
      publish,
      themeListeners,
      gatewayListeners,
      gatewayEventsStopped: gatewayEventsStopped.promise,
      unsubscribe,
      transport: bridgeMocks.transports[0] as { close: ReturnType<typeof vi.fn> },
      view,
      unmount,
    };
  };
}
