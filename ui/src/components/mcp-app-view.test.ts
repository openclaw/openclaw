import { GatewayErrorDetailCodes } from "@openclaw/gateway-protocol";
import { createComponent, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import type { ApplicationContext } from "../app/context.ts";
import { i18n } from "../i18n/index.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { createMcpBridgeFixture } from "../test-helpers/mcp-app-view-bridge.ts";
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
import { mountView } from "./mcp-app-view.test-support.ts";
import { McpAppPanel } from "./solid/mcp-app-panel.tsx";
const bridgeMocks = vi.hoisted(() => ({
  instances: [] as Array<Record<string, unknown>>,
  transports: [] as Array<Record<string, unknown>>,
  appModes: undefined as string[] | undefined,
}));
vi.mock("@modelcontextprotocol/ext-apps/app-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@modelcontextprotocol/ext-apps/app-bridge")>();
  const { createMcpAppBridgeMocks } = await import("./mcp-app-view-mocks.test-support.ts");
  return { ...actual, ...createMcpAppBridgeMocks(bridgeMocks) };
});
const mountBridge = createMcpBridgeFixture(bridgeMocks);
type BridgeFixture = Awaited<ReturnType<typeof mountBridge>>;
const partsEntrypoint = {
  toolName: "library",
  title: "Parts library",
  resourceUri: "ui://parts/library",
  entrypoint: { type: "global" as const },
};
function gatewayContext(request: unknown) {
  return {
    gateway: {
      snapshot: { client: { request }, phase: "connected", hello: null },
      connection: { gatewayUrl: "ws://gateway.example:8443/openclaw" },
    },
  };
}
function receiveMessages(view: BridgeFixture["view"]) {
  const received: McpAppMessageEventDetail[] = [];
  view.addEventListener(MCP_APP_MESSAGE_EVENT, (event: Event) => {
    event.preventDefault();
    const detail = (event as CustomEvent<McpAppMessageEventDetail>).detail;
    received.push(detail);
    detail.respond(true);
  });
  return received;
}
async function mountMessageView(id: string) {
  const fixture = await mountBridge(id);
  vi.spyOn(window, "confirm").mockReturnValue(false);
  fixture.frame.checkVisibility = () => true;
  fixture.frame.focus();
  return fixture;
}
function sendText(bridge: BridgeFixture["bridge"], text: string) {
  return bridge.messageHandler!({ role: "user", content: [{ type: "text", text }] });
}
function confirmation(view: BridgeFixture["view"]) {
  const dialog = view.querySelector<HTMLElement>('[role="alertdialog"]');
  expect(dialog).not.toBeNull();
  return dialog!;
}
function clickButton(root: ParentNode, label: string) {
  [...root.querySelectorAll("button")]
    .find((button) => button.textContent?.trim() === label)!
    .click();
}
function expectHost(bridge: BridgeFixture["bridge"], context: Record<string, unknown>) {
  expect(bridge.setHostContext).toHaveBeenLastCalledWith(expect.objectContaining(context));
}
describe("mcp-app-view localization", () => {
  it("retries initialization after its sandbox deadline through the error control", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const request = vi.fn(() =>
      Promise.resolve({
        sandboxUrl: "/mcp-app-sandbox?ticket=retry",
        sandboxPort: 8444,
        html: "<input value='unsaved'>",
        toolInput: {},
        toolResult: { content: [] },
      }),
    );
    const { view, unmount } = mountView(
      { sessionKey: "agent:main:main", viewId: "view-retry" },
      {
        gateway: {
          snapshot: {
            client: { request },
            phase: "connected",
            hello: gatewayHelloForMethods(["mcp.app.view"]),
          },
          connection: { gatewayUrl: "ws://gateway.example:8443/openclaw" },
        },
      },
    );
    try {
      await view.updateComplete;
      await vi.advanceTimersByTimeAsync(15_000);
      await view.updateComplete;
      expect(view.querySelector(".error")?.textContent).toContain("timed out");
      view.querySelector<HTMLButtonElement>(".error button")!.click();
      await vi.advanceTimersByTimeAsync(0);
      await view.updateComplete;
      expect(request).toHaveBeenCalledTimes(2);
      expect(view.querySelector(".error")).toBeNull();
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("retains the App frame across transport loss while retiring pending calls and changed identities", async () => {
    const { view, frame, bridge, request, gateway, publish, transport } =
      await mountBridge("view-offline");
    const pendingContext = deferred<{ state: McpAppContextState }>();
    const hello = gateway.snapshot.hello;
    request.mockReturnValueOnce(pendingContext.promise);
    const pending = bridge.updateModelContextHandler!({ structuredContent: { draft: "unsaved" } });
    const rejected = pending.catch((error: unknown) => error);
    publish({ ...gateway.snapshot, phase: "reconnecting", hello: null });
    flush();
    expect(view.querySelector("iframe")).toBe(frame);
    expect(transport.close).not.toHaveBeenCalled();
    await expect(bridge.updateModelContextHandler!({ structuredContent: {} })).rejects.toThrow(
      "gateway unavailable",
    );
    pendingContext.resolve({ state: null });
    expect(await rejected).toMatchObject({ name: "AbortError" });
    expect(
      request.mock.calls.filter(([method]) => method === "mcp.app.updateModelContext"),
    ).toHaveLength(1);
    publish({ ...gateway.snapshot, phase: "connected", hello });
    flush();
    expect(view.querySelector("iframe")).toBe(frame);
    await bridge.updateModelContextHandler!({ structuredContent: { draft: "resumed" } });
    expect(request.mock.calls.filter(([method]) => method === "mcp.app.view")).toHaveLength(1);
    publish({
      ...gateway.snapshot,
      client: createTestGatewayClient(vi.fn(() => new Promise(() => {}))),
    });
    flush();
    await waitForSolid(() => expect(view.querySelector("iframe")).toBeNull());
    expect(transport.close).toHaveBeenCalledOnce();
  });

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
    expectHost(bridge, { availableDisplayModes: ["inline"], displayMode: "inline" });
  });

  it("opens external links only from the live, visible, focused App frame", async () => {
    const { view, bridge, frame } = await mountBridge("view-external-link");
    const open = vi.spyOn(window, "open").mockReturnValue(window);
    const openLink = bridge.onopenlink!;
    const url = "https://example.com/parts";
    frame.checkVisibility = () => true;
    expect(await openLink({ url })).toEqual({ isError: true });
    expect(open).not.toHaveBeenCalled();

    frame.focus();
    expect(await openLink({ url })).toEqual({});
    expect(open).toHaveBeenCalledExactlyOnceWith(url, "_blank", "noopener,noreferrer");

    frame.checkVisibility = () => false;
    expect(await openLink({ url })).toEqual({ isError: true });
    frame.checkVisibility = () => true;
    await view.teardown();
    expect(await openLink({ url })).toEqual({ isError: true });
    expect(open).toHaveBeenCalledOnce();
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
    const received = receiveMessages(view);
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
    const dialog = confirmation(view);
    expect(dialog!.textContent).toContain("Parts library");
    expect(dialog!.textContent).toContain("Send this message to the assistant?");
    const previewElement = [...dialog!.querySelectorAll<HTMLElement>("[title]")].find(
      (element) => element.title === preview,
    )!;
    expect(previewElement.title).toBe(preview);
    expect(previewElement.textContent).toContain(preview.slice(0, 200));
    expect(previewElement.textContent).not.toContain(preview);
    await waitForSolid(() => expect(document.activeElement).toBe(dialog));
    clickButton(dialog, "Cancel");
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
    const { bridge, frame, view } = await mountMessageView("view-pending");
    const received = vi.fn();
    view.addEventListener(MCP_APP_MESSAGE_EVENT, received);
    const first = sendText(bridge, "First request");
    await view.updateComplete;
    const dialog = confirmation(view);
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
    const { bridge, frame, view } = await mountMessageView("view-keyboard");
    const received = receiveMessages(view);
    const pending = sendText(bridge, "Keyboard request");
    await view.updateComplete;
    const dialog = confirmation(view);
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
      const { bridge, view, unmount } = await mountMessageView("view-retired");
      const received = vi.fn();
      view.addEventListener(MCP_APP_MESSAGE_EVENT, received);
      const pending = sendText(bridge, "Retired request");
      await view.updateComplete;
      const dialog = confirmation(view);
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
    const context = gatewayContext(request);
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
        snapshot: { client, phase: "connected", hello: null },
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
      entrypoint: partsEntrypoint,
    };
    const provider = createSolidApplicationContextProvider(
      context as unknown as ApplicationContext,
    );
    const mounted = mountSolid(() => createComponent(McpAppPanel, { launch }), {
      wrapper: provider.wrapper,
    });
    const panel = mounted.container.querySelector("openclaw-mcp-app-panel")!;
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
    const context = gatewayContext(request);
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
    expect(request).toHaveBeenCalledWith(
      "mcp.app.updateModelContext",
      {
        sessionKey: "agent:main:main",
        viewId: expect.any(String),
        content: [{ type: "text", text: "selected item" }],
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("retains model context when its refresh fails and clears only a confirmed null", async () => {
    const state = {
      updateId: "retained-context",
      content: [{ type: "text", text: "selected item" }],
    };
    const { view, frame, bridge, request } = await mountBridge(
      "view-context-read-failure",
      true,
      true,
      {
        hostContext: { "openai/modelContext": state },
      },
    );
    const received: McpAppContextEventDetail[] = [];
    view.addEventListener(MCP_APP_CONTEXT_EVENT, (event: Event) => {
      received.push((event as CustomEvent<McpAppContextEventDetail>).detail);
    });
    request.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("Context read interrupted"));
    await expect(bridge.updateModelContextHandler!({ content: state.content })).resolves.toEqual(
      {},
    );
    expectHost(bridge, { "openai/modelContext": state });
    expect(received).toHaveLength(0);
    expect(view.querySelector("iframe")).toBe(frame);

    request.mockResolvedValueOnce({}).mockResolvedValueOnce({ state: null });
    await bridge.updateModelContextHandler!({ content: state.content });
    expectHost(bridge, { "openai/modelContext": null });
    expect(received).toHaveLength(1);
    expect(received[0]?.state).toBeNull();
    expect(view.querySelector("iframe")).toBe(frame);
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
    expectHost(bridge, { "openai/modelContext": null });
  });
  it("clears successive app updates in the Apps page's embedded conversation", async () => {
    const [
      { createMountedPanes },
      { installTranscriptDomMocks },
      { installOutboxBrowserStorage },
      { createStorageMock },
      { AppsPage },
    ] = await Promise.all([
      import("../pages/chat/chat-pane-mounted.test-support.ts"),
      import("../pages/chat/components/chat-transcript.test-support.ts"),
      import("../pages/chat/outbox-browser.test-support.ts"),
      import("../test-helpers/storage.ts"),
      import("../pages/apps/apps-page.tsx"),
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
              entrypoints: [{ ...partsEntrypoint, title: "Library" }],
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
    const provider = createApplicationContextProvider(fixture.context);
    const initialized = deferred();
    provider.addEventListener(MCP_APP_CONTEXT_EVENT, () => initialized.resolve(), { once: true });
    document.body.append(provider);
    const { container: apps, unmount } = mountSolid(
      () => createComponent(AppsPage, { appSearch: "?server=parts&tool=library" }),
      {
        container: provider,
        wrapper: createSolidApplicationContextProvider(fixture.context).wrapper,
      },
    );
    try {
      flush();
      await vi.dynamicImportSettled();
      flush();
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
      expectHost(bridge, { "openai/modelContext": null });
    } finally {
      unmount();
      provider.remove();
      await vi.dynamicImportSettled();
      vi.useRealTimers();
    }
  });
  it("does not let App parameters replace the mounted session, agent, or view", async () => {
    const viewId = "bound-view";
    const { bridge, request } = await mountBridge(viewId);
    const hostileAppInput = {
      content: [{ type: "text", text: "context" }],
      sessionKey: "foreign",
      viewId: "foreign-view",
      agentId: "foreign-agent",
    };
    await bridge.updateModelContextHandler?.(hostileAppInput);
    expect(request).toHaveBeenCalledWith(
      "mcp.app.updateModelContext",
      {
        sessionKey: "agent:main:main",
        viewId,
        content: [{ type: "text", text: "context" }],
      },
      { signal: expect.any(AbortSignal) },
    );
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
    expectHost(bridge, { containerDimensions: { width: 720, height: 600 } });
    view.height = 480;
    await view.updateComplete;
    expect(view.querySelector("iframe")?.style.height).toBe("480px");
    expectHost(bridge, { containerDimensions: { width: 720, height: 480 } });
    const onHeightChange = vi.fn();
    view.onHeightChange = onHeightChange;
    bridge.onsizechange?.({ height: 900 });
    expect(frame.style.height).toBe("900px");
    expect(view.querySelector<HTMLElement>(".mount")?.style.minHeight).toBe("900px");
    expect(onHeightChange).toHaveBeenLastCalledWith(900);
    bridge.onsizechange?.({ height: Number.NaN });
    expect(frame.style.height).toBe("900px");
    expect(onHeightChange).toHaveBeenCalledTimes(1);
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
    expect(onHeightChange).toHaveBeenCalledTimes(1);
    expectHost(bridge, { containerDimensions: { width: 720, height: 480 } });
    height = 760;
    resize?.();
    expectHost(bridge, { containerDimensions: { width: 720, height: 760 } });
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
  it.each(["completed", "timed out"])(
    "cancels App RPCs after graceful teardown has %s",
    async (outcome) => {
      const { bridge, frame, request, view } = await mountBridge("view-teardown-rpcs");
      await view.updateComplete;
      const teardownFinished = deferred<Record<string, never>>();
      const pendingSave = deferred<Record<string, never>>();
      bridge.teardownResource.mockReturnValueOnce(teardownFinished.promise);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const teardown = view.teardown();
        expect(bridge.teardownResource).toHaveBeenCalledOnce();
        request.mockReturnValueOnce(pendingSave.promise);
        const save = bridge.updateModelContextHandler!({ structuredContent: { draft: "saved" } });
        const rejected = save.catch((error: unknown) => error);
        const signal = request.mock.calls.at(-1)?.[2]?.signal;
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal?.aborted).toBe(false);
        expect(frame.isConnected).toBe(true);
        if (outcome === "completed") {
          teardownFinished.resolve({});
        } else {
          await vi.advanceTimersByTimeAsync(250);
        }
        await teardown;
        expect(frame.isConnected).toBe(false);
        expect(signal?.aborted).toBe(true);
        pendingSave.resolve({});
        expect(await rejected).toMatchObject({ name: "AbortError" });
        await expect(
          bridge.updateModelContextHandler!({ structuredContent: {} }),
        ).rejects.toMatchObject({ name: "AbortError" });
      } finally {
        vi.useRealTimers();
      }
    },
  );
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
      .toContain("Aplicativo MCP indisponível: Gateway do aplicativo MCP indisponível");
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
        gatewayContext(request),
      );
      await expect
        .poll(() => view.querySelector(".error")?.textContent)
        .toContain("MCP App sandbox URL is invalid");
      expect(view.querySelector("iframe")).toBeNull();
    },
  );
});
