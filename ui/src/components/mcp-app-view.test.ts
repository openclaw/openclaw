import { GatewayErrorDetailCodes } from "@openclaw/gateway-protocol";
import { createComponent } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import type { GatewayEventFrame } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import { i18n } from "../i18n/index.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import {
  MCP_APP_VIEW_EXPIRED_EVENT,
  MCP_APP_MESSAGE_EVENT,
  MCP_APP_CONTEXT_EVENT,
  type McpAppContextEventDetail,
  type McpAppContextState,
  type McpAppMessageEventDetail,
} from "./mcp-app-security.ts";
import type { McpAppViewElement } from "./mcp-app-view-controller.ts";
import { McpAppPanel, type McpAppPanelElement } from "./solid/mcp-app-panel.tsx";

const bridgeMocks = vi.hoisted(() => ({
  instances: [] as Array<Record<string, unknown>>,
  transports: [] as Array<Record<string, unknown>>,
  appModes: undefined as string[] | undefined,
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
    getAppCapabilities = () => ({ availableDisplayModes: bridgeMocks.appModes });
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

const { McpAppView } = await import("./mcp-app-view.tsx");
function mountView(props: Parameters<typeof McpAppView>[0], context: object = {}) {
  const supplied = context as Partial<ApplicationContext>;
  const provider = createSolidApplicationContextProvider({
    ...supplied,
    gateway: {
      subscribe: () => () => {},
      snapshot: { client: null, phase: "stopped" },
      ...supplied.gateway,
    },
  } as ApplicationContext);
  const mounted = mountSolid(() => createComponent(McpAppView, props), {
    wrapper: provider.wrapper,
  });
  return { ...mounted, view: mounted.container.querySelector<McpAppViewElement>("mcp-app-view")! };
}

describe("mcp-app-view localization", () => {
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

  async function mountBridge(
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
  }

  it("keeps resource display hints within the initialized App capabilities", async () => {
    bridgeMocks.appModes = ["inline"];
    const { view, bridge } = await mountBridge("view-modes", true, true, {
      displayModes: {
        availableDisplayModes: ["inline", "fullscreen"],
        preferredDisplayMode: "fullscreen",
      },
    });
    expect(view.displayMode).toBe("inline");
    await expect(bridge.onrequestdisplaymode?.({ mode: "fullscreen" })).resolves.toEqual({
      mode: "inline",
    });
    expect(bridge.setHostContext).toHaveBeenLastCalledWith(
      expect.objectContaining({ availableDisplayModes: ["inline"], displayMode: "inline" }),
    );
  });

  it("reveals questions and approvals only for its conversation without replacing the App frame", async () => {
    const { view, frame, gatewayListeners, gatewayEventsStopped, unmount } = await mountBridge(
      "view-input-" + crypto.randomUUID(),
    );
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
    expect(view.querySelector("iframe")).toBe(frame);
    view.displayMode = "fullscreen";
    await view.updateComplete;
    emit("plugin.approval.requested", { request: { sessionKey: "agent:other:main" } });
    expect(view.displayMode).toBe("fullscreen");
    emit("plugin.approval.requested", { request: { sessionKey: view.sessionKey } });
    await view.updateComplete;
    expect(view.displayMode).toBe("inline");
    expect(view.querySelector("iframe")).toBe(frame);
    unmount();
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
    frame.focus();
    expect(await send([{ type: "text", text: "Hidden" }])).toEqual({ isError: true });
    frame.checkVisibility = () => true;
    const nativeConfirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const preview = "Please compare the selected parts. ".repeat(8);
    const cancelled = send([{ type: "text", text: preview }]);
    await view.updateComplete;
    const dialog = view.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("Parts library");
    expect(dialog!.textContent).toContain("Send this message to the assistant?");
    const previewElement = [...dialog!.querySelectorAll<HTMLElement>("[title]")].find(
      (element) => element.title === preview,
    )!;
    expect(previewElement.title).toBe(preview);
    expect(previewElement.textContent).toContain(preview.slice(0, 200));
    expect(previewElement.textContent).not.toContain(preview);
    await waitForSolid(() => expect(document.activeElement).toBe(dialog));
    [...dialog!.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Cancel")!
      .click();
    expect(await cancelled).toEqual({ isError: true });
    await view.updateComplete;
    expect(received).toHaveLength(0);
    expect(view.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(frame);

    const accepted = send([
      { type: "text", text: "one" },
      { type: "text", text: "two" },
    ]);
    await view.updateComplete;
    [...view.querySelectorAll('[role="alertdialog"] button')]
      .find((button) => button.textContent?.trim() === "Send")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(await accepted).toEqual({});
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(received[0]).toEqual({
      sessionKey: "agent:main:main",
      viewId: view.viewId,
      target: "active",
      respond: expect.any(Function),
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

  it("cancels with Escape and rejects a second pending message without replacing its preview", async () => {
    const { bridge, frame, view } = await mountBridge("view-pending-" + crypto.randomUUID());
    vi.spyOn(window, "confirm").mockReturnValue(false);
    frame.checkVisibility = () => true;
    frame.focus();
    const received = vi.fn();
    view.addEventListener(MCP_APP_MESSAGE_EVENT, received);
    const first = bridge.messageHandler!({
      role: "user",
      content: [{ type: "text", text: "First request" }],
    });
    await view.updateComplete;
    const dialog = view.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    // A second app click can refocus its frame while the first prompt is pending.
    frame.focus();
    expect(
      await bridge.messageHandler!({
        role: "user",
        content: [{ type: "text", text: "Second request" }],
      }),
    ).toEqual({ isError: true });
    await view.updateComplete;
    expect(view.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
    expect(dialog!.textContent).toContain("First request");
    expect(dialog!.textContent).not.toContain("Second request");
    dialog!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(await first).toEqual({ isError: true });
    await view.updateComplete;
    expect(received).not.toHaveBeenCalled();
    expect(view.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(frame);
  });

  it("sends with Enter on the focused strip and restores frame focus", async () => {
    const { bridge, frame, view } = await mountBridge("view-keyboard-" + crypto.randomUUID());
    vi.spyOn(window, "confirm").mockReturnValue(false);
    frame.checkVisibility = () => true;
    frame.focus();
    const received: McpAppMessageEventDetail[] = [];
    view.addEventListener(MCP_APP_MESSAGE_EVENT, (event: Event) => {
      event.preventDefault();
      const detail = (event as CustomEvent<McpAppMessageEventDetail>).detail;
      received.push(detail);
      detail.respond(true);
    });
    const pending = bridge.messageHandler!({
      role: "user",
      content: [{ type: "text", text: "Keyboard request" }],
    });
    await view.updateComplete;
    const dialog = view.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    await waitForSolid(() => expect(document.activeElement).toBe(dialog));
    dialog!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(await pending).toEqual({});
    await view.updateComplete;
    expect(received).toHaveLength(1);
    expect(received[0]!.content).toEqual([{ type: "text", text: "Keyboard request" }]);
    expect(document.activeElement).toBe(frame);
    expect(view.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it.each(["disconnect", "viewId", "sessionKey", "agentId"] as const)(
    "cancels pending confirmation on %s before a stale Send can dispatch",
    async (change) => {
      const { bridge, frame, view, unmount } = await mountBridge(
        "view-retired-" + crypto.randomUUID(),
      );
      vi.spyOn(window, "confirm").mockReturnValue(false);
      frame.checkVisibility = () => true;
      frame.focus();
      const received = vi.fn();
      view.addEventListener(MCP_APP_MESSAGE_EVENT, received);
      const pending = bridge.messageHandler!({
        role: "user",
        content: [{ type: "text", text: "Retired request" }],
      });
      await view.updateComplete;
      const dialog = view.querySelector<HTMLElement>('[role="alertdialog"]');
      expect(dialog).not.toBeNull();
      const send = [...dialog!.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Send",
      )!;
      if (change === "disconnect") {
        unmount();
      } else {
        view[change] = "replacement";
        await view.updateComplete;
      }
      send.click();
      expect(await pending).toEqual({ isError: true });
      expect(received).not.toHaveBeenCalled();
    },
  );

  it("delegates expired-view recovery to its board owner", async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error("MCP App view expired"), {
        details: { code: GatewayErrorDetailCodes.MCP_APP_VIEW_EXPIRED },
      });
    });
    const context = {
      gateway: {
        snapshot: { client: { request } },
        connection: { gatewayUrl: "ws://gateway.example:8443/openclaw" },
      },
    };
    const { view } = mountView(
      { sessionKey: "agent:main:main", viewId: "mcp-app-expired", surface: "board" },
      context,
    );
    const expired = vi.fn();
    view.addEventListener(MCP_APP_VIEW_EXPIRED_EVENT, expired);

    await expect.poll(() => expired).toHaveBeenCalledOnce();
    await view.updateComplete;
    expect(view.querySelector('[role="status"]')).toBeNull();
  });

  it("relaunches an ended entrypoint through the panel's existing launch request", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "mcp.app.launch") {
        return { viewId: "expired-entrypoint" };
      }
      throw Object.assign(new Error("expired"), {
        details: { code: GatewayErrorDetailCodes.MCP_APP_VIEW_EXPIRED },
      });
    });
    const client = createTestGatewayClient(request);
    const context = {
      gateway: {
        snapshot: { client, phase: "connected" },
        connectionRevision: 1,
        connection: { gatewayUrl: "ws://gateway.example:8443/openclaw" },
        subscribe: () => () => {},
      },
    };
    const launch = {
      owner: client,
      sessionKey: "agent:main:main",
      agentId: "main",
      serverName: "parts",
      entrypoint: {
        toolName: "library",
        title: "Parts library",
        resourceUri: "ui://parts/library",
        entrypoint: { type: "global" as const },
      },
    };
    const provider = createSolidApplicationContextProvider(
      context as unknown as ApplicationContext,
    );
    const mounted = mountSolid(() => createComponent(McpAppPanel, { launch }), {
      wrapper: provider.wrapper,
    });
    const panel = mounted.container.querySelector<McpAppPanelElement>("openclaw-mcp-app-panel")!;
    const expired = deferred();
    panel.addEventListener(MCP_APP_VIEW_EXPIRED_EVENT, () => expired.resolve(), { once: true });
    await expired.promise;
    const view = panel.querySelector("mcp-app-view")!;
    await view.updateComplete;
    const button = [...view.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "Relaunch",
    );
    expect(button).toBeDefined();
    button!.click();
    await vi.dynamicImportSettled();
    const launchParams = {
      sessionKey: "agent:main:main",
      agentId: "main",
      serverName: "parts",
      toolName: "library",
      entrypointType: "global",
    };
    expect(request.mock.calls.filter(([method]) => method === "mcp.app.launch")).toEqual([
      ["mcp.app.launch", launchParams],
      ["mcp.app.launch", launchParams],
    ]);
  });

  it("does not renew the view for unrelated upstream expiry errors", async () => {
    const request = vi.fn(async () => {
      throw new Error("upstream token expired");
    });
    const context = {
      gateway: {
        snapshot: { client: { request } },
        connection: { gatewayUrl: "ws://gateway.example:8443/openclaw" },
      },
    };
    const { view } = mountView(
      { sessionKey: "agent:main:main", viewId: "mcp-app-upstream-expired" },
      context,
    );
    const expired = vi.fn();
    view.addEventListener(MCP_APP_VIEW_EXPIRED_EVENT, expired);

    await expect
      .poll(() => view.querySelector(".error")?.textContent)
      .toContain("upstream token expired");
    expect(expired).not.toHaveBeenCalled();
  });

  it("does not advertise or install message support for read-only views", async () => {
    const { bridge, view } = await mountBridge(`view-read-only-${crypto.randomUUID()}`, false);
    expect(view.querySelector('[role="status"]')?.textContent).toContain(
      "Send a message to interact again",
    );
    expect(bridge.capabilities).not.toHaveProperty("message");
    expect(bridge.messageHandler).toBeUndefined();
    expect(bridge.capabilities).not.toHaveProperty("updateModelContext");
    expect(bridge.capabilities).not.toHaveProperty("serverResources");
    expect(bridge.updateModelContextHandler).toBeUndefined();
  });

  it("shows an inactive banner after a bridge request expires", async () => {
    const { bridge, request, view } = await mountBridge(`view-expired-${crypto.randomUUID()}`);
    request.mockRejectedValueOnce(
      Object.assign(new Error("MCP App view expired or is not authorized"), {
        details: { code: GatewayErrorDetailCodes.MCP_APP_VIEW_EXPIRED },
      }),
    );
    await expect(
      bridge.updateModelContextHandler?.({ content: [{ type: "text", text: "selection" }] }),
    ).rejects.toThrow("expired");
    await view.updateComplete;
    expect(view.querySelector('[role="status"]')?.textContent).toContain(
      "Send a message to interact again",
    );
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

  it("does not republish consumed context when an earlier bridge refresh settles", async () => {
    const { bridge, request, view, gatewayListeners } = await mountBridge(
      `view-context-${crypto.randomUUID()}`,
    );
    const state = { updateId: "revision-one", content: [{ type: "text", text: "selected item" }] };
    const refresh = deferred<{ state: typeof state }>();
    const received: McpAppContextEventDetail[] = [];
    view.addEventListener(MCP_APP_CONTEXT_EVENT, (event: Event) => {
      received.push((event as CustomEvent<McpAppContextEventDetail>).detail);
    });
    request.mockResolvedValue({ state });
    await bridge.updateModelContextHandler?.({ content: state.content });
    expect(received.at(-1)?.state).toEqual(state);
    request.mockReturnValue(refresh.promise);
    const emit = (payload: Record<string, unknown>) => {
      for (const listener of gatewayListeners) {
        listener({ type: "event", event: "mcp.app.hostContextChanged", payload });
      }
    };
    emit({ viewId: view.viewId });
    emit({ viewId: view.viewId, modelContext: null, updateId: state.updateId });
    expect.soft(received.at(-1)?.state).toBeNull();
    refresh.resolve({ state });
    await refresh.promise;
    await view.updateComplete;
    expect(received.at(-1)?.state).toBeNull();
    expect(bridge.setHostContext).toHaveBeenLastCalledWith(
      expect.objectContaining({ "openai/modelContext": null }),
    );
  });

  it("clears successive app updates in the Apps page's embedded conversation", async () => {
    const [
      { createMountedPanes },
      { installTranscriptDomMocks },
      { installOutboxBrowserStorage },
      { createStorageMock },
    ] = await Promise.all([
      import("../pages/chat/chat-pane-mounted.test-support.ts"),
      import("../pages/chat/components/chat-transcript.test-support.ts"),
      import("../pages/chat/outbox-browser.test-support.ts"),
      import("../test-helpers/storage.ts"),
      import("../pages/apps/apps-page.ts"),
    ]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    installOutboxBrowserStorage();
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    installTranscriptDomMocks();
    vi.spyOn(HTMLIFrameElement.prototype, "contentWindow", "get").mockReturnValue(window);
    const frameSource = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "src")!;
    vi.spyOn(HTMLIFrameElement.prototype, "src", "set").mockImplementation(function (
      this: HTMLIFrameElement,
      value,
    ) {
      frameSource.set!.call(this, value);
      queueMicrotask(() =>
        window.dispatchEvent(
          new MessageEvent("message", {
            source: window,
            data: { method: "ui/notifications/sandbox-proxy-ready" },
          }),
        ),
      );
    });
    const sessionKey = "agent:main:apps-context";
    const viewId = "apps-context-view";
    const fixture = createMountedPanes([
      {
        key: sessionKey,
        sessionId: "session-apps-context",
        agentId: "main",
        kind: "direct",
        updatedAt: 1,
      },
    ]);
    const { gateway } = fixture.context;
    gateway.snapshot.sessionKey = sessionKey;
    gateway.snapshot.hello!.features!.methods!.push("mcp.app.discover");
    const client = gateway.snapshot.client!;
    const originalRequest = client.request.bind(client);
    const first: NonNullable<McpAppContextState> = {
      updateId: "selection-one",
      content: [
        { type: "text", text: "selected hex bolt", _meta: { "openai/title": "Hex bolt" } },
        { type: "image", data: "AA==", mimeType: "image/png" },
      ],
    };
    const second: NonNullable<McpAppContextState> = {
      updateId: "selection-two",
      content: [
        ...first.content!,
        { type: "resource", resource: { uri: "parts://bolt", text: "Steel hex bolt" } },
      ],
    };
    let modelContext: McpAppContextState = null;
    const request = createGatewayRequestMock(async (method, params, options) => {
      if (method === "agents.list") {
        return {
          defaultId: "main",
          mainKey: "main",
          agents: [{ id: "main", model: { primary: "openai/gpt-4.1" } }],
        };
      }
      if (method === "models.list") {
        return { models: [{ id: "gpt-4.1", name: "Test model", provider: "openai" }] };
      }
      if (method === "mcp.app.discover") {
        return {
          servers: [
            {
              serverName: "parts",
              label: "Parts library",
              entrypoints: [
                {
                  title: "Library",
                  toolName: "library",
                  resourceUri: "ui://parts/library",
                  entrypoint: { type: "global" },
                },
              ],
            },
          ],
        };
      }
      if (method === "mcp.app.launch") {
        return { viewId };
      }
      if (method === "mcp.app.view") {
        return {
          sandboxUrl: "/mcp-app-sandbox?ticket=test",
          sandboxPort: 8444,
          html: "<!doctype html><button>Choose part</button>",
          toolInput: {},
          toolResult: { content: [] },
          messageSupported: true,
          updateModelContextSupported: true,
        };
      }
      if (method === "mcp.app.updateModelContext") {
        modelContext = modelContext ? second : first;
        fixture.emitGatewayEvent("mcp.app.hostContextChanged", { viewId });
        return { _meta: { "openai/modelContext": { updateId: modelContext.updateId } } };
      }
      if (method === "mcp.app.modelContext") {
        return { state: modelContext };
      }
      return originalRequest(method, params, options);
    });
    const appClient = createTestGatewayClient(request);
    client.request = appClient.request.bind(appClient);
    // SAFETY: the registered Apps page exposes these properties to its rendering callers.
    const apps = document.createElement("openclaw-apps-page") as HTMLElement & {
      readonly updateComplete: Promise<boolean>;
    };
    Object.assign(apps, { appSearch: "?server=parts&tool=library" });
    const provider = createApplicationContextProvider(fixture.context);
    const initialized = deferred();
    provider.addEventListener(MCP_APP_CONTEXT_EVENT, () => initialized.resolve(), { once: true });
    provider.append(apps);
    document.body.append(provider);
    try {
      await apps.updateComplete;
      await vi.dynamicImportSettled();
      await apps.updateComplete;
      expect(
        apps.querySelector('[role="alert"]')?.textContent,
        JSON.stringify(request.mock.calls.map(([method]) => method)),
      ).toBeUndefined();
      const pane = apps.querySelector("openclaw-chat-pane")!;
      expect(pane).not.toBeNull();
      await pane.updateComplete;
      await vi.dynamicImportSettled();
      await pane.updateComplete;
      expect(pane.querySelector('[role="alert"]')?.textContent).toBeUndefined();
      await initialized.promise;
      const strip = pane.querySelector("openclaw-mcp-app-context-strip")!;
      expect(pane.classList.contains("mcp-app-conversation")).toBe(true);
      expect(strip).not.toBeNull();
      const itemSelector = ".mcp-app-context__item";
      const bridge = bridgeMocks.instances[0] as Awaited<ReturnType<typeof mountBridge>>["bridge"];
      await bridge.updateModelContextHandler!({ content: first.content });
      await waitForSolid(() => expect(strip.querySelectorAll(itemSelector)).toHaveLength(2));
      await bridge.updateModelContextHandler!({ content: second.content });
      await waitForSolid(() => expect(strip.querySelectorAll(itemSelector)).toHaveLength(3));
      expect(
        request.mock.calls.filter(([method]) => method === "mcp.app.updateModelContext"),
      ).toHaveLength(2);
      modelContext = null;
      fixture.emitGatewayEvent("mcp.app.hostContextChanged", {
        viewId,
        modelContext: null,
        updateId: second.updateId,
      });
      await waitForSolid(() => expect(strip.textContent?.trim()).toBe(""));
      expect(bridge.setHostContext).toHaveBeenLastCalledWith(
        expect.objectContaining({ "openai/modelContext": null }),
      );
    } finally {
      provider.remove();
      await vi.dynamicImportSettled();
      vi.useRealTimers();
    }
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

    const { bridge, frame, themeListeners, unsubscribe, view, unmount } = await mountBridge(
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
    expect(view.querySelector("iframe")?.style.height).toBe("480px");
    expect(bridge.setHostContext).toHaveBeenLastCalledWith(
      expect.objectContaining({ containerDimensions: { width: 720, height: 480 } }),
    );

    bridge.onsizechange?.({ height: 900 });
    expect(frame.style.height).toBe("900px");
    for (const change of [
      { title: "Updated library" },
      { surface: "board" },
      { relaunching: true },
    ]) {
      Object.assign(view, change);
      await view.updateComplete;
      expect(view.querySelector("iframe")).toBe(frame);
      expect(frame.style.height).toBe("900px");
    }

    view.fillContainer = true;
    await view.updateComplete;
    expect(view.querySelector("iframe")?.style.height).toBe("100%");
    bridge.onsizechange?.({ height: 900 });
    expect(view.querySelector("iframe")?.style.height).toBe("100%");
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
    expect(view.querySelector("iframe")?.style.height).toBe("480px");
    bridge.onsizechange?.({ height: 900 });
    expect(view.querySelector("iframe")?.style.height).toBe("900px");

    unmount();
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

    const { view } = mountView({ sessionKey: "agent:main:main", viewId: "view-1" });

    await expect
      .poll(() => view.querySelector(".error")?.textContent)
      .toBe("Aplicativo MCP indisponível: Gateway do aplicativo MCP indisponível");
  });

  it.each([
    ["foreign origin", "https://attacker.example/mcp-app-sandbox", 8444, undefined],
    ["data URL", "data:text/html;base64,cHJveHk=", 8444, undefined],
    ["same gateway port", "/mcp-app-sandbox", 8443, undefined],
    ["host origin", "/mcp-app-sandbox", 8444, "host"],
  ])(
    "rejects a %s sandbox URL through a reconstructed view",
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
        messageSupported: false,
      }));
      const { view } = mountView(
        { sessionKey: "agent:main:main", viewId: crypto.randomUUID() },
        {
          gateway: {
            snapshot: { client: { request } },
            connection: { gatewayUrl: "ws://gateway.example:8443/openclaw" },
          },
        },
      );

      await expect
        .poll(() => view.querySelector(".error")?.textContent)
        .toContain("MCP App sandbox URL is invalid");
      expect(view.querySelector("iframe")).toBeNull();
    },
  );
});
