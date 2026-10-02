import { GatewayErrorDetailCodes } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import type { GatewayEventFrame } from "../api/gateway.ts";
import { i18n } from "../i18n/index.ts";
import {
  MCP_APP_VIEW_EXPIRED_EVENT,
  MCP_APP_MESSAGE_EVENT,
  type McpAppMessageEventDetail,
} from "./mcp-app-security.ts";

const bridgeMocks = vi.hoisted(() => ({
  instances: [] as Array<Record<string, unknown>>,
  transports: [] as Array<Record<string, unknown>>,
}));

// This constructor seam is a complete factory, and the unit-mock-registry
// project prevents its substituted classes from reaching unrelated files.
vi.mock("@modelcontextprotocol/ext-apps/app-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@modelcontextprotocol/ext-apps/app-bridge")>();
  class AppBridge {
    oninitialized?: () => void;
    messageHandler?: (params: {
      role: "user";
      content: Array<{ type: string; text?: string }>;
    }) => Promise<{ isError?: boolean }>;
    updateModelContextHandler?: (params: {
      content?: Array<{ type: string; text?: string }>;
      structuredContent?: Record<string, unknown>;
    }) => Promise<Record<string, never>>;
    onsizechange?: (params: { height?: number }) => void;
    getAppCapabilities = () => ({});
    setHostContext = vi.fn();
    teardownResource = vi.fn(async () => ({}));
    sendSandboxResourceReady = vi.fn(async () => undefined);
    sendToolInput = vi.fn(async () => undefined);
    sendToolResult = vi.fn(async () => undefined);
    onrequestteardown?: () => void;

    constructor(
      _client: unknown,
      _hostInfo: unknown,
      public capabilities: Record<string, unknown>,
      public options: Record<string, unknown>,
    ) {
      bridgeMocks.instances.push(this as unknown as Record<string, unknown>);
    }

    set onmessage(handler: NonNullable<AppBridge["messageHandler"]>) {
      this.messageHandler = handler;
    }

    set onupdatemodelcontext(handler: NonNullable<AppBridge["updateModelContextHandler"]>) {
      this.updateModelContextHandler = handler;
    }

    protected replaceRequestHandler() {}

    emit(type: string) {
      if (type === "requestteardown") {
        this.onrequestteardown?.();
      }
    }

    async connect() {
      this.oninitialized?.();
    }
  }

  class PostMessageTransport {
    close = vi.fn(async () => undefined);

    constructor() {
      bridgeMocks.transports.push(this as unknown as Record<string, unknown>);
    }
  }

  return { ...actual, AppBridge, PostMessageTransport };
});

const { McpAppView } = await import("./mcp-app-view.ts");
type McpAppViewElement = InstanceType<typeof McpAppView>;

const MCP_APP_VIEW_ELEMENT_NAME = `test-mcp-app-view-${crypto.randomUUID()}`;

// Keep the mounted view and i18n controller in the current module graph when
// the non-isolated runner has retained an earlier production registration.
class TestMcpAppView extends McpAppView {}

customElements.define(MCP_APP_VIEW_ELEMENT_NAME, TestMcpAppView);

describe("mcp-app-view localization", () => {
  afterEach(async () => {
    bridgeMocks.instances.length = 0;
    bridgeMocks.transports.length = 0;
    document.body.replaceChildren();
    delete (document as unknown as Record<string, unknown>).activeElement;
    delete document.documentElement.dataset.themeMode;
    document.documentElement.style.removeProperty("--card");
    document.documentElement.style.removeProperty("--text");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await i18n.setLocale("en");
  });

  async function mountBridge(
    viewId: string,
    messageSupported = true,
    updateModelContextSupported = messageSupported,
  ) {
    vi.spyOn(HTMLIFrameElement.prototype, "contentWindow", "get").mockReturnValue(window);
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
    const request = vi.fn(async (_method: string, _params: Record<string, unknown>) => ({
      sandboxUrl: "/mcp-app-sandbox?ticket=test",
      sandboxPort: 8444,
      html: "<!doctype html><button>Send</button>",
      toolInput: {},
      toolResult: { content: [{ type: "text", text: "ready" }] },
      messageSupported,
      updateModelContextSupported,
      state: null,
    }));
    const view = document.createElement(MCP_APP_VIEW_ELEMENT_NAME) as McpAppViewElement;
    Reflect.set(view, "context", {
      gateway: {
        snapshot: { client: { request } },
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
    });
    view.sessionKey = "agent:main:main";
    view.viewId = viewId;
    document.body.append(view);

    await expect.poll(() => view.shadowRoot?.querySelector("iframe")).not.toBeNull();
    const frame = view.shadowRoot!.querySelector("iframe")!;
    await expect.poll(() => frame.getAttribute("src")).toContain("/mcp-app-sandbox?ticket=test");
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
    await expect.poll(() => bridgeMocks.instances.length).toBe(1);
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
        setHostContext: ReturnType<typeof vi.fn>;
        teardownResource: ReturnType<typeof vi.fn>;
        emit(type: string): void;
      },
      frame,
      request,
      themeListeners,
      gatewayListeners,
      gatewayEventsReady: gatewayEventsReady.promise,
      gatewayEventsStopped: gatewayEventsStopped.promise,
      unsubscribe,
      transport: bridgeMocks.transports[0] as { close: ReturnType<typeof vi.fn> },
      view,
    };
  }

  it("reveals questions and approvals only for its conversation without replacing the App frame", async () => {
    const { view, frame, gatewayListeners, gatewayEventsReady, gatewayEventsStopped } =
      await mountBridge("view-input-" + crypto.randomUUID());
    await gatewayEventsReady;
    const emit = (event: string, payload: unknown) => {
      for (const listener of gatewayListeners) {
        listener({ type: "event", event, payload });
      }
    };
    view.displayMode = "fullscreen";
    await view.updateComplete;
    emit("question.requested", { sessionKey: "agent:other:main", status: "pending" });
    expect(view.displayMode).toBe("fullscreen");
    emit("question.resolved", { sessionKey: view.sessionKey, status: "answered" });
    expect(view.displayMode).toBe("fullscreen");
    emit("question.requested", { sessionKey: view.sessionKey, status: "pending" });
    await view.updateComplete;
    expect(view.displayMode).toBe("inline");
    expect(view.shadowRoot?.querySelector("iframe")).toBe(frame);
    view.displayMode = "fullscreen";
    await view.updateComplete;
    emit("plugin.approval.requested", { request: { sessionKey: "agent:other:main" } });
    expect(view.displayMode).toBe("fullscreen");
    emit("plugin.approval.requested", { request: { sessionKey: view.sessionKey } });
    await view.updateComplete;
    expect(view.displayMode).toBe("inline");
    expect(view.shadowRoot?.querySelector("iframe")).toBe(frame);
    view.remove();
    await gatewayEventsStopped;
    expect(gatewayListeners.size).toBe(0);
  });

  it("sends rich user messages only after visible focus, confirmation, and conversation custody", async () => {
    const { bridge, frame, view } = await mountBridge("view-message-" + crypto.randomUUID());
    expect(bridge.capabilities).toMatchObject({
      message: { text: {}, image: {}, resource: {}, resourceLink: {} },
      experimental: { "openai/message": {} },
    });
    const received: McpAppMessageEventDetail[] = [];
    view.addEventListener(MCP_APP_MESSAGE_EVENT, (event: Event) => {
      event.preventDefault();
      const detail = (event as CustomEvent<McpAppMessageEventDetail>).detail;
      received.push(detail);
      detail.respond(true);
    });
    const send = async (content: Array<{ type: string; text?: string }>) =>
      bridge.messageHandler!({ role: "user", content });
    expect(await send([{ type: "text", text: "Background" }])).toEqual({ isError: true });
    frame.checkVisibility = () => false;
    Object.defineProperty(document, "activeElement", { get: () => frame, configurable: true });
    expect(await send([{ type: "text", text: "Hidden" }])).toEqual({ isError: true });
    frame.checkVisibility = () => true;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    expect(await send([{ type: "text", text: "Needs approval" }])).toEqual({ isError: true });
    confirm.mockReturnValue(true);
    expect(
      await send([
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ]),
    ).toEqual({});
    expect(received[0]).toMatchObject({
      sessionKey: "agent:main:main",
      target: "active",
      content: [
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ],
    });
    for (const content of [
      [{ type: "text", text: "/approve" }],
      [{ type: "text", text: "!pwd" }],
      [{ type: "text", text: "   " }],
      [{ type: "image" }],
    ]) {
      expect(await send(content)).toEqual({ isError: true });
    }
    expect(received).toHaveLength(1);
  });

  it("signals its board owner when the view lease has expired", async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error("MCP App view expired"), {
        details: { code: GatewayErrorDetailCodes.MCP_APP_VIEW_EXPIRED },
      });
    });
    const view = document.createElement(MCP_APP_VIEW_ELEMENT_NAME) as McpAppViewElement;
    Reflect.set(view, "context", {
      gateway: {
        snapshot: { client: { request } },
        connection: { gatewayUrl: "ws://gateway.example:8443/openclaw" },
      },
    });
    view.sessionKey = "agent:main:main";
    view.viewId = "mcp-app-expired";
    const expired = vi.fn();
    view.addEventListener(MCP_APP_VIEW_EXPIRED_EVENT, expired);
    document.body.append(view);

    await expect.poll(() => expired).toHaveBeenCalledOnce();
    await expect
      .poll(() => view.shadowRoot?.querySelector(".error")?.textContent)
      .toContain("MCP App view expired");
  });

  it("does not renew the view for unrelated upstream expiry errors", async () => {
    const request = vi.fn(async () => {
      throw new Error("upstream token expired");
    });
    const view = document.createElement(MCP_APP_VIEW_ELEMENT_NAME) as McpAppViewElement;
    Reflect.set(view, "context", {
      gateway: {
        snapshot: { client: { request } },
        connection: { gatewayUrl: "ws://gateway.example:8443/openclaw" },
      },
    });
    view.sessionKey = "agent:main:main";
    view.viewId = "mcp-app-upstream-expired";
    const expired = vi.fn();
    view.addEventListener(MCP_APP_VIEW_EXPIRED_EVENT, expired);
    document.body.append(view);

    await expect
      .poll(() => view.shadowRoot?.querySelector(".error")?.textContent)
      .toContain("upstream token expired");
    expect(expired).not.toHaveBeenCalled();
  });

  it("does not advertise or install message support for read-only views", async () => {
    const { bridge } = await mountBridge(`view-read-only-${crypto.randomUUID()}`, false);
    expect(bridge.capabilities).not.toHaveProperty("message");
    expect(bridge.messageHandler).toBeUndefined();
    expect(bridge.capabilities).not.toHaveProperty("updateModelContext");
    expect(bridge.capabilities).not.toHaveProperty("serverResources");
    expect(bridge.updateModelContextHandler).toBeUndefined();
  });

  it("forwards update-model-context through the bound Gateway view", async () => {
    const { bridge, request } = await mountBridge(`view-context-${crypto.randomUUID()}`);
    expect(bridge.capabilities).toMatchObject({ updateModelContext: { text: {} } });
    await expect(
      bridge.updateModelContextHandler?.({
        content: [{ type: "text", text: "selected item" }],
      }),
    ).resolves.toBeDefined();
    expect(request).toHaveBeenCalledWith("mcp.app.updateModelContext", {
      sessionKey: "agent:main:main",
      viewId: expect.any(String),
      content: [{ type: "text", text: "selected item" }],
    });
  });

  it("does not let App parameters replace the mounted session, agent, or view", async () => {
    const viewId = "bound-" + crypto.randomUUID();
    const { bridge, request } = await mountBridge(viewId);
    const hostileAppInput = {
      content: [{ type: "text", text: "context" }],
      sessionKey: "foreign",
      viewId: "foreign-view",
      agentId: "foreign-agent",
    };
    await bridge.updateModelContextHandler?.(hostileAppInput);
    expect(request).toHaveBeenCalledWith("mcp.app.updateModelContext", {
      sessionKey: "agent:main:main",
      viewId,
      content: [{ type: "text", text: "context" }],
    });
  });

  it("pushes live theme and container changes and cleans up their observers", async () => {
    let resize: (() => void) | undefined;
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {}
        disconnect() {
          disconnect();
        }
      },
    );
    let width = 640;
    let height = 480;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ width, height }) as DOMRect,
    );
    document.documentElement.dataset.themeMode = "dark";
    document.documentElement.style.setProperty("--card", "#161920");
    document.documentElement.style.setProperty("--text", "#d4d4d8");

    const { bridge, themeListeners, unsubscribe, view } = await mountBridge(
      `view-context-${crypto.randomUUID()}`,
    );
    expect(bridge.options.hostContext).toMatchObject({
      theme: "dark",
      containerDimensions: { width: 640, height: 600 },
      styles: {
        variables: {
          "--color-background-primary": "#161920",
          "--color-text-primary": "#d4d4d8",
        },
      },
    });
    await expect.poll(() => themeListeners.size).toBe(1);

    document.documentElement.dataset.themeMode = "light";
    document.documentElement.style.setProperty("--card", "#ffffff");
    document.documentElement.style.setProperty("--text", "#403c35");
    themeListeners.values().next().value?.();
    expect(bridge.setHostContext).toHaveBeenLastCalledWith(
      expect.objectContaining({
        theme: "light",
        styles: {
          variables: expect.objectContaining({
            "--color-background-primary": "#ffffff",
            "--color-text-primary": "#403c35",
          }),
        },
      }),
    );

    width = 720;
    resize?.();
    expect(bridge.setHostContext).toHaveBeenLastCalledWith(
      expect.objectContaining({ containerDimensions: { width: 720, height: 600 } }),
    );

    view.height = 480;
    await view.updateComplete;
    expect(view.shadowRoot?.querySelector("iframe")?.style.height).toBe("480px");
    expect(bridge.setHostContext).toHaveBeenLastCalledWith(
      expect.objectContaining({ containerDimensions: { width: 720, height: 480 } }),
    );

    bridge.onsizechange?.({ height: 900 });
    expect(view.shadowRoot?.querySelector("iframe")?.style.height).toBe("900px");

    view.fillContainer = true;
    await view.updateComplete;
    expect(view.shadowRoot?.querySelector("iframe")?.style.height).toBe("100%");
    bridge.onsizechange?.({ height: 900 });
    expect(view.shadowRoot?.querySelector("iframe")?.style.height).toBe("100%");
    expect(bridge.setHostContext).toHaveBeenLastCalledWith(
      expect.objectContaining({ containerDimensions: { width: 720, height: 480 } }),
    );

    height = 760;
    resize?.();
    expect(bridge.setHostContext).toHaveBeenLastCalledWith(
      expect.objectContaining({ containerDimensions: { width: 720, height: 760 } }),
    );

    view.fillContainer = false;
    await view.updateComplete;
    expect(view.shadowRoot?.querySelector("iframe")?.style.height).toBe("480px");
    bridge.onsizechange?.({ height: 900 });
    expect(view.shadowRoot?.querySelector("iframe")?.style.height).toBe("900px");

    view.remove();
    await expect.poll(() => disconnect).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(themeListeners.size).toBe(0);
  });

  it("keeps the frame connected through teardown and installs only the latest replacement", async () => {
    const pending = deferred<Record<string, never>>();
    const { bridge, frame, request, transport, view } = await mountBridge(
      `view-teardown-${crypto.randomUUID()}`,
    );
    bridge.teardownResource.mockReturnValueOnce(pending.promise);

    view.viewId = `view-intermediate-${crypto.randomUUID()}`;
    await view.updateComplete;
    await expect.poll(() => bridge.teardownResource).toHaveBeenCalledOnce();
    expect(frame.isConnected).toBe(true);
    expect(transport.close).not.toHaveBeenCalled();

    const latestViewId = `view-latest-${crypto.randomUUID()}`;
    view.viewId = latestViewId;
    await view.updateComplete;
    pending.resolve({});

    await expect.poll(() => frame.isConnected).toBe(false);
    await expect.poll(() => request.mock.calls.at(-1)?.[1]).toMatchObject({ viewId: latestViewId });
    expect(bridge.teardownResource).toHaveBeenCalledOnce();
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("removes the frame after the bounded teardown timeout", async () => {
    const { bridge, frame, transport, view } = await mountBridge(
      `view-timeout-${crypto.randomUUID()}`,
    );
    bridge.teardownResource.mockReturnValueOnce(new Promise<void>(() => {}));

    view.viewId = `view-after-timeout-${crypto.randomUUID()}`;
    await view.updateComplete;
    await expect.poll(() => bridge.teardownResource).toHaveBeenCalledOnce();
    expect(frame.isConnected).toBe(true);

    await expect.poll(() => transport.close, { timeout: 1_000 }).toHaveBeenCalledOnce();
    expect(frame.isConnected).toBe(false);
  });

  it("honors an app-requested teardown before detaching its frame", async () => {
    const pending = deferred<Record<string, never>>();
    const { bridge, frame, transport } = await mountBridge(
      `view-request-teardown-${crypto.randomUUID()}`,
    );
    bridge.teardownResource.mockReturnValueOnce(pending.promise);

    bridge.emit("requestteardown");
    await expect.poll(() => bridge.teardownResource).toHaveBeenCalledOnce();
    expect(frame.isConnected).toBe(true);
    expect(transport.close).not.toHaveBeenCalled();

    pending.resolve({});
    await expect.poll(() => frame.isConnected).toBe(false);
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("renders gateway failures with localized copy", async () => {
    i18n.registerTranslation("pt-BR", {
      mcpApp: {
        title: "Aplicativo MCP",
        unavailable: "Aplicativo MCP indisponível: {error}",
        errors: {
          gatewayUnavailable: "Gateway do aplicativo MCP indisponível",
        },
      },
    });
    await i18n.setLocale("pt-BR");

    const view = document.createElement(MCP_APP_VIEW_ELEMENT_NAME) as McpAppViewElement;
    view.sessionKey = "agent:main:main";
    view.viewId = "view-1";
    document.body.append(view);

    await expect
      .poll(() => view.shadowRoot?.querySelector(".error")?.textContent)
      .toBe("Aplicativo MCP indisponível: Gateway do aplicativo MCP indisponível");
  });

  it.each([
    ["foreign origin", "https://attacker.example/mcp-app-sandbox", 8444, undefined],
    ["data URL", "data:text/html;base64,cHJveHk=", 8444, undefined],
    ["same gateway port", "/mcp-app-sandbox", 8443, undefined],
    ["host origin", "/mcp-app-sandbox", 8444, "host"],
  ])(
    "rejects a %s sandbox URL through the mounted view",
    async (_label, sandboxUrl, sandboxPort, sandboxOrigin) => {
      const resolvedSandboxOrigin =
        sandboxOrigin === "host" ? window.location.origin : sandboxOrigin;
      const request = vi.fn(async () => ({
        sandboxUrl,
        sandboxPort,
        ...(resolvedSandboxOrigin ? { sandboxOrigin: resolvedSandboxOrigin } : {}),
        html: "<p>unsafe</p>",
        toolInput: null,
        toolResult: null,
      }));
      const view = document.createElement(MCP_APP_VIEW_ELEMENT_NAME) as McpAppViewElement;
      Reflect.set(view, "context", {
        gateway: {
          snapshot: { client: { request } },
          connection: { gatewayUrl: "ws://gateway.example:8443/openclaw" },
        },
      });
      view.sessionKey = "agent:main:main";
      view.viewId = crypto.randomUUID();
      document.body.append(view);

      await expect
        .poll(() => view.shadowRoot?.querySelector(".error")?.textContent)
        .toContain("MCP App sandbox URL is invalid");
      expect(view.shadowRoot?.querySelector("iframe")).toBeNull();
    },
  );
});
