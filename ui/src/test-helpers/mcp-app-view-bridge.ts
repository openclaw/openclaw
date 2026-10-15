import { afterEach, expect, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import type { GatewayEventFrame } from "../api/gateway.ts";
import { mountView } from "../components/mcp-app-view.test-support.ts";
import { i18n } from "../i18n/index.ts";

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
    const messageListeners: EventListenerOrEventListenerObject[] = [];
    const addEventListener = window.addEventListener.bind(window);
    vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
      if (type === "message") {
        messageListeners.push(listener);
      }
      addEventListener(type, listener, options);
    });
    const themeListeners = new Set<() => void>();
    const gatewayListeners = new Set<(event: GatewayEventFrame) => void>();
    const gatewayEventsReady = deferred();
    const gatewayEventsStopped = deferred();
    const unsubscribe = vi.fn();
    const request = vi.fn(
      async (_method: string, _params: Record<string, unknown>): Promise<unknown> => ({
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
    const { view, unmount } = mountView(
      { sessionKey: "agent:main:main", viewId, title: "Parts library" },
      {
        gateway: {
          snapshot: { client: { request }, phase: "connected" },
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
        },
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
    const readyEvent = {
      data: { method: "ui/notifications/sandbox-proxy-ready" },
      source: frame.contentWindow,
    } as MessageEvent;
    expect(messageListeners.length).toBeGreaterThan(0);
    expect(readyEvent.source).toBe(frame.contentWindow);
    for (const readyListener of messageListeners) {
      if (typeof readyListener === "function") {
        readyListener.call(window, readyEvent);
      } else {
        readyListener.handleEvent(readyEvent);
      }
    }
    await gatewayEventsReady.promise;
    expect(bridgeMocks.instances).toHaveLength(1);
    return {
      bridge: bridgeMocks.instances[0] as {
        capabilities: Record<string, unknown>;
        options: { hostContext?: Record<string, unknown> };
        messageHandler?: (params: {
          role: "user";
          content: Array<{ type: string; text?: string }>;
        }) => Promise<{ isError?: boolean }>;
        updateModelContextHandler?: (params: {
          content?: Array<{ type: string; text?: string }>;
          structuredContent?: Record<string, unknown>;
        }) => Promise<Record<string, never>>;
        onsizechange?: (params: { height?: number }) => void;
        onopenlink?: (params: { url: string }) => Promise<{ isError?: boolean }>;
        onrequestdisplaymode?: (params: {
          mode: "inline" | "fullscreen";
        }) => Promise<{ mode: string }>;
        setHostContext: ReturnType<typeof vi.fn>;
        teardownResource: ReturnType<typeof vi.fn>;
        emit(type: string): void;
      },
      frame,
      request,
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
