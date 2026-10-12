import { InMemoryTransport } from "@modelcontextprotocol/client";
import { App } from "@modelcontextprotocol/ext-apps";
import { render } from "lit";
import { createComponent } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ApplicationContext } from "../app/context.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { bindMcpAppResourceHandlers, OpenClawAppBridge } from "./mcp-app-bridge.ts";
import { McpAppConfirm } from "./mcp-app-confirm.ts";
import {
  buildMcpAppHostCapabilities,
  dispatchMcpAppMessage,
  MCP_APP_MESSAGE_EVENT,
  MCP_APP_FILE_OPEN_EVENT,
  type McpAppFileOpenEventDetail,
  type McpAppMessageEventDetail,
} from "./mcp-app-security.ts";
import type { McpAppViewElement } from "./mcp-app-view-controller.ts";
import { McpAppView } from "./mcp-app-view.tsx";

const transportMocks = vi.hoisted(() => ({ next: undefined as (() => unknown) | undefined }));

vi.mock("@modelcontextprotocol/ext-apps/app-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@modelcontextprotocol/ext-apps/app-bridge")>();
  return {
    ...actual,
    PostMessageTransport: vi.fn(function () {
      return transportMocks.next?.();
    }),
  };
});

afterEach(() => {
  document.body.replaceChildren();
  delete (document as unknown as Record<string, unknown>).activeElement;
  transportMocks.next = undefined;
  vi.restoreAllMocks();
});

it("confirms file paths in the pane before requesting or opening a file", async () => {
  const [hostTransport, appTransport] = InMemoryTransport.createLinkedPair();
  const bridge = new OpenClawAppBridge(
    null,
    { name: "OpenClaw", version: "test" },
    buildMcpAppHostCapabilities(undefined, false, false, { openFiles: true }),
  );
  const app = new App({ name: "file-proof", version: "1" }, {}, { autoResize: false });
  const root = document.createElement("div");
  const frame = document.createElement("iframe");
  document.body.append(root, frame);
  frame.checkVisibility = () => true;
  let disposed = false;
  let prompted = createDeferred();
  const confirmation = new McpAppConfirm(() => {
    render(confirmation.render(), root);
    prompted.resolve();
  });
  const request = vi.fn(async () => ({ path: "/workspace/parts.txt", name: "parts.txt" }));
  const opened = vi.fn();
  root.addEventListener(MCP_APP_FILE_OPEN_EVENT, (event) => {
    event.preventDefault();
    const detail = (event as CustomEvent<McpAppFileOpenEventDetail>).detail;
    opened(detail);
    detail.respond(true);
  });
  const owner = {
    bridge,
    request,
    sessionKey: "file-session",
    viewId: "file-view",
    iframe: frame,
    openFilesSupported: true,
    confirmOpenFile: (text: string) =>
      confirmation.request({
        frame,
        title: "Parts library",
        text,
        kind: "file",
        isCurrent: () => !disposed,
      }),
    isDisposed: () => disposed,
    addCleanup: vi.fn(),
    dispatchEvent: (event: Event) => root.dispatchEvent(event),
    onModelContextChanged: vi.fn(),
    onConversationInputRequested: vi.fn(),
    subscribeEvents: () => undefined,
  };
  bindMcpAppResourceHandlers(owner);
  vi.spyOn(window, "confirm").mockReturnValue(false);
  await bridge.connect(hostTransport);
  await app.connect(appTransport);
  const open = () =>
    app.request(
      { method: "openai/files/open", params: { path: "parts.txt" } },
      z.record(z.string(), z.unknown()),
    );
  try {
    for (const action of ["Cancel", "Open", "retire"] as const) {
      frame.focus();
      prompted = createDeferred();
      const opening = open();
      await Promise.race([prompted.promise, opening]);
      const dialog = root.querySelector<HTMLElement>('[role="alertdialog"]');
      expect(dialog).not.toBeNull();
      expect(dialog!.textContent).toContain("Parts library");
      expect(dialog!.querySelector('[title="parts.txt"]')).not.toBeNull();
      expect(request).toHaveBeenCalledTimes(action === "retire" ? 1 : 0);
      if (action === "retire") {
        disposed = true;
        confirmation.cancel();
      } else {
        Array.from(dialog!.querySelectorAll("button"))
          .find((button) => button.textContent?.trim() === action)!
          .click();
      }
      expect(await opening).toEqual(action === "Open" ? {} : { isError: true });
      expect(opened).toHaveBeenCalledTimes(action === "Cancel" ? 0 : 1);
    }
    expect(request).toHaveBeenCalledExactlyOnceWith("mcp.app.openFile", { path: "parts.txt" });
    expect(opened).toHaveBeenCalledWith({
      sessionKey: "file-session",
      viewId: "file-view",
      path: "/workspace/parts.txt",
      name: "parts.txt",
      respond: expect.any(Function),
    });
    expect(window.confirm).not.toHaveBeenCalled();
  } finally {
    confirmation.cancel();
    await app.close();
    await bridge.close();
  }
});

it("negotiates extension capabilities and preserves rich request metadata over the actual AppBridge transport", async () => {
  const [hostTransport, appTransport] = InMemoryTransport.createLinkedPair();
  const bridge = new OpenClawAppBridge(
    null,
    { name: "OpenClaw", version: "test" },
    buildMcpAppHostCapabilities(undefined, true, true, {
      richModelContext: true,
      fileResources: true,
    }),
    {
      hostContext: {
        displayMode: "inline",
        availableDisplayModes: ["inline", "fullscreen"],
        "openai/modelContext": null,
        "openai/deepLink": { url: "/parts?q=bolt" },
      },
    },
  );
  const frame = document.createElement("iframe");
  document.body.append(frame);
  frame.checkVisibility = () => true;
  Object.defineProperty(document, "activeElement", { get: () => frame, configurable: true });
  const received = vi.fn();
  frame.addEventListener(MCP_APP_MESSAGE_EVENT, (event) => {
    event.preventDefault();
    const detail = (event as CustomEvent<McpAppMessageEventDetail>).detail;
    received(detail);
    detail.respond(true);
  });
  bridge.setMessageHandler(async (params) =>
    (await dispatchMcpAppMessage(frame, { sessionKey: "one", viewId: "app" }, params, () => true))
      ? {}
      : { isError: true },
  );
  const context = vi.fn(async (_params: unknown) => ({
    _meta: { "openai/modelContext": { updateId: "update-1" } },
  }));
  bridge.setUpdateModelContextHandler(context);
  const writes = vi.fn(async (_params: unknown) => ({ outcome: "saved", etag: "saved-1" }));
  bridge.setHostRequestHandler("openai/resources/write", writes);
  const app = new App(
    { name: "spec-proof", version: "1" },
    { availableDisplayModes: ["inline", "fullscreen"] },
    { autoResize: false },
  );
  await bridge.connect(hostTransport);
  await app.connect(appTransport);
  // The installed stable SDK helper omits extension metadata; exercise the documented wire method.
  const sendMessage = (params: Parameters<typeof dispatchMcpAppMessage>[2]) =>
    app.request({ method: "ui/message", params }, z.object({ isError: z.boolean().optional() }));
  try {
    expect(app.getHostCapabilities()?.experimental).toMatchObject({
      "openai/modelContext": {},
      "openai/message": {},
      "openai/resource": {},
    });
    expect(app.getHostContext()).toMatchObject({
      "openai/deepLink": { url: "/parts?q=bolt" },
      "openai/modelContext": null,
    });
    const content = [
      {
        type: "text" as const,
        text: "part",
        _meta: {
          "openai/title": "Part",
          "openai/thumbnail": { src: "https://example.com/part.png" },
        },
      },
      { type: "image" as const, data: "AA==", mimeType: "image/png" },
    ];
    const result = await app.updateModelContext({ content, structuredContent: { selected: 1 } });
    expect(result).toMatchObject({ _meta: { "openai/modelContext": { updateId: "update-1" } } });
    expect(context.mock.calls[0]?.[0]).toMatchObject({
      content,
      structuredContent: { selected: 1 },
    });
    await sendMessage({
      role: "user",
      content,
      _meta: { "openai/message": { target: "new" } },
    });
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ target: "new", content }));
    for (const options of [null, [], 1, { target: "other" }, { send: false }]) {
      expect(
        await sendMessage({
          role: "user",
          content: [{ type: "text", text: "invalid options" }],
          _meta: { "openai/message": options },
        }),
      ).toEqual({ isError: true });
    }
    for (const command of ["/reset", "!pwd"]) {
      expect(
        await sendMessage({
          role: "user",
          content: [
            { type: "text", text: "Harmless attachment", _meta: { "openai/title": "Note" } },
            { type: "text", text: "  " + command },
          ],
        }),
      ).toEqual({ isError: true });
    }
    expect(received).toHaveBeenCalledTimes(1);
    const saved = await app.request(
      {
        method: "openai/resources/write",
        params: { uri: "openclaw-file://one", blob: "AA==", ifMatch: "v1" },
      },
      z.object({ outcome: z.literal("saved"), etag: z.string() }),
    );
    expect(saved).toEqual({ outcome: "saved", etag: "saved-1" });
    expect(writes.mock.calls[0]?.[0]).toEqual({
      uri: "openclaw-file://one",
      blob: "AA==",
      ifMatch: "v1",
    });
  } finally {
    await app.close();
    await bridge.close();
  }
});

it("routes vendor links through the mounted view and AppBridge only for its focused current owner", async () => {
  const [hostTransport, appTransport] = InMemoryTransport.createLinkedPair();
  const transportReady = createDeferred();
  transportMocks.next = () => {
    transportReady.resolve();
    return hostTransport;
  };
  const app = new App({ name: "link-proof", version: "1" }, {}, { autoResize: false });
  const client = {
    request: vi.fn(async () => ({
      sandboxUrl: "/mcp-app-sandbox?ticket=test",
      sandboxPort: 8444,
      html: "<p>Parts library</p>",
      toolInput: {},
      toolResult: { content: [] },
    })),
  };
  const hello = { type: "hello-ok" };
  const navigate = vi.fn();
  const gateway = {
    snapshot: { client, phase: "connected", hello },
    connection: { gatewayUrl: "ws://gateway.example:8443/openclaw" },
    connectionRevision: 1,
    subscribe: () => () => {},
  };
  const provider = createSolidApplicationContextProvider({
    gateway,
    navigate,
    theme: { subscribe: () => () => {} },
  } as unknown as ApplicationContext);
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
  const mounted = mountSolid(
    () =>
      createComponent(McpAppView, {
        sessionKey: "agent:main:one",
        agentId: "main",
        viewId: "current-view",
      }),
    { wrapper: provider.wrapper },
  );
  const view = mounted.container.querySelector<McpAppViewElement>("mcp-app-view")!;
  await transportReady.promise;
  await app.connect(appTransport);
  await waitForSolid(() => expect(view.querySelector("iframe")).not.toBeNull());
  const frame = view.querySelector("iframe")!;
  let focused = true;
  let visible = true;
  frame.checkVisibility = () => visible;
  Object.defineProperty(document, "activeElement", {
    get: () => (focused ? frame : document.body),
    configurable: true,
  });
  const externalWindow = { opener: window };
  const open = vi.spyOn(window, "open").mockReturnValue(externalWindow as unknown as Window);
  const vendorUrl = "https://chatgpt.com/plugins/parts/app/browse?path=%2Fparts%3Fq%3Dbolt";
  try {
    for (const url of [
      vendorUrl,
      "codex://plugins/parts/app/browse?path=%2Fparts%3Fq%3Dbolt",
      "chatgpt://plugins/parts/app/browse?path=%2Fparts%3Fq%3Dbolt",
    ]) {
      expect(await app.openLink({ url })).toEqual({});
      expect(navigate).toHaveBeenLastCalledWith("apps", {
        search: "?tool=browse&path=%2Fparts%3Fq%3Dbolt&plugin=parts",
      });
    }
    expect(navigate).toHaveBeenCalledTimes(3);
    expect(open).not.toHaveBeenCalled();
    expect(await app.openLink({ url: "https://example.com/docs" })).toEqual({});
    expect(open).toHaveBeenCalledWith("https://example.com/docs", "_blank", "noopener,noreferrer");
    expect(externalWindow.opener).toBeNull();
    const refused = async () => {
      expect(await app.openLink({ url: vendorUrl })).toEqual({ isError: true });
      expect(navigate).toHaveBeenCalledTimes(3);
      expect(open).toHaveBeenCalledTimes(1);
    };
    focused = false;
    await refused();
    focused = true;
    visible = false;
    await refused();
    visible = true;
    gateway.snapshot.client = { request: vi.fn(client.request) };
    await refused();
    gateway.snapshot.client = client;
    gateway.snapshot.phase = "reconnecting";
    await refused();
    gateway.snapshot.phase = "connected";
    gateway.connectionRevision = 2;
    await refused();
    gateway.connectionRevision = 1;
    gateway.snapshot.hello = { type: "hello-ok" };
    await refused();
    gateway.snapshot.hello = hello;
  } finally {
    await view.teardown();
    mounted.unmount();
    await app.close();
  }
});

it("forwards resource metadata and keeps subscriptions with the extracted bridge lifetime", async () => {
  const [hostTransport, appTransport] = InMemoryTransport.createLinkedPair();
  const bridge = new OpenClawAppBridge(
    null,
    { name: "OpenClaw", version: "test" },
    buildMcpAppHostCapabilities(undefined, true, false, { fileResources: true }),
  );
  const app = new App({ name: "resources-proof", version: "1" }, {}, { autoResize: false });
  const frame = document.createElement("iframe");
  document.body.append(frame);
  let disposed = false;
  const cleanups = new Set<() => void>();
  type EventListener = Parameters<
    Parameters<typeof bindMcpAppResourceHandlers>[0]["subscribeEvents"]
  >[0];
  const listeners = new Set<EventListener>();
  const subscriptionEntered = createDeferred();
  const subscriptionResult = createDeferred<Record<string, unknown>>();
  const request = vi.fn(
    async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (method === "mcp.app.readResource") {
        return { contents: [{ uri: params.uri, text: "representation" }] };
      }
      if (method === "mcp.app.subscribeResource" && params.uri === "openclaw-file://late") {
        subscriptionEntered.resolve();
        return subscriptionResult.promise;
      }
      return {};
    },
  );
  const start = bindMcpAppResourceHandlers({
    bridge,
    request,
    sessionKey: "one",
    viewId: "app",
    iframe: frame,
    fileResourcesSupported: true,
    confirmOpenFile: vi.fn(async () => false),
    isDisposed: () => disposed,
    addCleanup: (cleanup) => {
      cleanups.add(cleanup);
    },
    dispatchEvent: (event) => frame.dispatchEvent(event),
    onModelContextChanged: vi.fn(),
    onConversationInputRequested: vi.fn(),
    subscribeEvents: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  const notification = vi.spyOn(bridge, "notification");
  app.setNotificationHandler(
    "notifications/resources/updated",
    { params: z.object({ uri: z.string() }) },
    () => {},
  );
  await bridge.connect(hostTransport);
  await app.connect(appTransport);
  start();
  const emit = (viewId: string, uri: string) => {
    for (const listener of listeners) {
      listener({ type: "event", event: "mcp.app.resourceUpdated", payload: { viewId, uri } });
    }
  };
  const rpc = (method: string, uri: string) =>
    app.request({ method, params: { uri } }, z.record(z.string(), z.unknown()));
  try {
    const read = await app.request(
      {
        method: "resources/read",
        params: { uri: "openclaw-file://one", _meta: { "openai/representation": "text" } },
      },
      z.record(z.string(), z.unknown()),
    );
    expect(read).toEqual({ contents: [{ uri: "openclaw-file://one", text: "representation" }] });
    expect(request).toHaveBeenLastCalledWith("mcp.app.readResource", {
      uri: "openclaw-file://one",
      _meta: { "openai/representation": "text" },
    });
    request.mockResolvedValueOnce({ contents: [{ uri: "openclaw-file://one", text: 42 }] });
    await expect(rpc("resources/read", "openclaw-file://one")).rejects.toThrow(
      "Invalid Gateway MCP result",
    );
    request.mockResolvedValueOnce(42);
    await expect(rpc("resources/subscribe", "openclaw-file://malformed")).rejects.toThrow();
    emit("app", "openclaw-file://malformed");
    expect(notification).not.toHaveBeenCalled();
    await rpc("resources/subscribe", "openclaw-file://one");
    emit("other", "openclaw-file://one");
    emit("app", "openclaw-file://unknown");
    expect(notification).not.toHaveBeenCalled();
    emit("app", "openclaw-file://one");
    expect(notification).toHaveBeenCalledExactlyOnceWith({
      method: "notifications/resources/updated",
      params: { uri: "openclaw-file://one" },
    });
    await rpc("resources/unsubscribe", "openclaw-file://one");
    emit("app", "openclaw-file://one");
    expect(notification).toHaveBeenCalledTimes(1);
    await rpc("resources/subscribe", "openclaw-file://two");
    const late = rpc("resources/subscribe", "openclaw-file://late");
    await subscriptionEntered.promise;
    disposed = true;
    for (const cleanup of cleanups) {
      cleanup();
    }
    cleanups.clear();
    expect(listeners.size).toBe(0);
    expect(request).toHaveBeenCalledWith("mcp.app.unsubscribeResource", {
      uri: "openclaw-file://two",
    });
    subscriptionResult.resolve({});
    await late;
    expect(request).toHaveBeenLastCalledWith("mcp.app.unsubscribeResource", {
      uri: "openclaw-file://late",
    });
    expect(notification).toHaveBeenCalledTimes(1);
  } finally {
    disposed = true;
    for (const cleanup of cleanups) {
      cleanup();
    }
    await app.close();
    await bridge.close();
  }
});
