import { InMemoryTransport } from "@modelcontextprotocol/client";
import { App } from "@modelcontextprotocol/ext-apps";
import { createComponent } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createTestGatewayClient,
  createGatewayRequestMock,
} from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { boardWidget } from "./board/board-view.test-support.ts";
import { bindMcpAppResourceHandlers, OpenClawAppBridge } from "./mcp-app-bridge.ts";
import { McpAppConfirmation } from "./mcp-app-confirm-solid.tsx";
import { createMcpAppConfirm } from "./mcp-app-confirm.ts";
import {
  buildMcpAppHostCapabilities,
  dispatchMcpAppMessage,
  MCP_APP_MESSAGE_EVENT,
  MCP_APP_FILE_OPEN_EVENT,
  type McpAppFileOpenEventDetail,
  type McpAppMessageEventDetail,
} from "./mcp-app-security.ts";
import type { McpAppViewPayload } from "./mcp-app-view-types.ts";
import { mockMcpSandboxProxyReady, mountView } from "./mcp-app-view.test-support.ts";

const transportMocks = vi.hoisted(() => ({ next: undefined as (() => unknown) | undefined }));
const recordSchema = z.record(z.string(), z.unknown());
const hostInfo = { name: "OpenClaw", version: "test" };
const requestRecord = (app: App, method: string, params: Record<string, unknown>) =>
  app.request({ method, params }, recordSchema);
type ResourceOwner = Parameters<typeof bindMcpAppResourceHandlers>[0];

function bindResources(
  owner: Pick<ResourceOwner, "bridge" | "request" | "iframe"> & Partial<ResourceOwner>,
) {
  return bindMcpAppResourceHandlers({
    binding: () => ({
      sessionKey: "one",
      viewId: "app",
      client: createTestGatewayClient(createGatewayRequestMock()),
      scope: 1,
      connectionRevision: 1,
    }),
    releaseResourceSubscription: async () => ({}),
    confirmOpenFile: async () => false,
    isDisposed: () => false,
    addCleanup: () => {},
    dispatchEvent: (event) => owner.iframe.dispatchEvent(event),
    onModelContextChanged: () => {},
    onConversationInputRequested: () => {},
    subscribeEvents: () => undefined,
    ...owner,
  });
}

function createBridgePair(
  capabilities: ReturnType<typeof buildMcpAppHostCapabilities>,
  options?: ConstructorParameters<typeof OpenClawAppBridge>[3],
  appCapabilities: ConstructorParameters<typeof App>[1] = {},
) {
  const [hostTransport, appTransport] = InMemoryTransport.createLinkedPair();
  const bridge = new OpenClawAppBridge(null, hostInfo, capabilities, options);
  const app = new App({ name: "proof", version: "1" }, appCapabilities, { autoResize: false });
  return {
    bridge,
    app,
    connect: async () => {
      await bridge.connect(hostTransport);
      await app.connect(appTransport);
    },
    close: async () => {
      await app.close();
      await bridge.close();
    },
  };
}

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
  const { bridge, app, connect, close } = createBridgePair(
    buildMcpAppHostCapabilities(undefined, false, false, { openFiles: true }),
  );
  const root = document.createElement("div");
  const frame = document.createElement("iframe");
  document.body.append(root, frame);
  frame.checkVisibility = () => true;
  let disposed = false;
  const confirmation = createMcpAppConfirm();
  const mounted = mountSolid(() => createComponent(McpAppConfirmation, { confirmation }), {
    container: root,
  });
  const request = vi.fn(async () => ({ path: "/workspace/parts.txt", name: "parts.txt" }));
  const opened = vi.fn();
  root.addEventListener(MCP_APP_FILE_OPEN_EVENT, (event) => {
    event.preventDefault();
    const detail = (event as CustomEvent<McpAppFileOpenEventDetail>).detail;
    opened(detail);
    detail.respond(true);
  });
  bindResources({
    bridge,
    request,
    binding: () => ({
      sessionKey: "file-session",
      viewId: "file-view",
      client: createTestGatewayClient(createGatewayRequestMock()),
      scope: 1,
      connectionRevision: 1,
    }),
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
    dispatchEvent: (event: Event) => root.dispatchEvent(event),
  });
  vi.spyOn(window, "confirm").mockReturnValue(false);
  await connect();
  const open = () => requestRecord(app, "openai/files/open", { path: "parts.txt" });
  try {
    for (const action of ["Cancel", "Open", "retire"] as const) {
      frame.focus();
      const opening = open();
      await waitForSolid(() => expect(mounted.getByRole("alertdialog")).toBeDefined());
      const dialog = mounted.getByRole("alertdialog");
      expect(dialog.textContent).toContain("Parts library");
      expect(dialog.querySelector('[title="parts.txt"]')).not.toBeNull();
      expect(request).toHaveBeenCalledTimes(action === "retire" ? 1 : 0);
      if (action === "retire") {
        disposed = true;
        confirmation.cancel();
      } else {
        mounted.getByRole("button", { name: action }).click();
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
    await close();
    mounted.unmount();
  }
});

it("negotiates extension capabilities and preserves rich request metadata over the actual AppBridge transport", async () => {
  const { bridge, app, connect, close } = createBridgePair(
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
    { availableDisplayModes: ["inline", "fullscreen"] },
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
  await connect();
  // The installed stable SDK helper omits extension metadata; exercise the documented wire method.
  type Message = Parameters<typeof dispatchMcpAppMessage>[2];
  const sendMessage = (content: Message["content"], _meta?: Message["_meta"]) =>
    requestRecord(app, "ui/message", { role: "user", content, _meta });
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
    for (const block of [
      { type: "text", text: 1 },
      { type: "image", data: 1, mimeType: "image/png" },
      { type: "resource_link", uri: 1, name: "Part" },
      { type: "resource_link", uri: "parts://bolt", name: 1 },
      { type: "resource", resource: { uri: 1, text: "Part" } },
      { type: "resource", resource: { uri: "parts://bolt", text: 1 } },
      { type: "resource", resource: { uri: "parts://bolt", blob: 1 } },
    ]) {
      await expect(
        requestRecord(app, "ui/message", { role: "user", content: [block] }),
      ).rejects.toThrow("Invalid params for ui/message");
    }
    expect(received).not.toHaveBeenCalled();
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
    const selection = { content, structuredContent: { selected: 1 } };
    const result = await app.updateModelContext(selection);
    expect(result).toMatchObject({ _meta: { "openai/modelContext": { updateId: "update-1" } } });
    expect(context.mock.calls[0]?.[0]).toMatchObject(selection);
    await sendMessage(content, { "openai/message": { target: "new" } });
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ target: "new", content }));
    for (const options of [null, [], 1, { target: "other" }, { send: false }]) {
      expect(
        await sendMessage([{ type: "text", text: "invalid options" }], {
          "openai/message": options,
        }),
      ).toEqual({ isError: true });
    }
    for (const command of ["/reset", "!pwd"]) {
      expect(
        await sendMessage([
          { type: "text", text: "Harmless attachment", _meta: { "openai/title": "Note" } },
          { type: "text", text: "  " + command },
        ]),
      ).toEqual({ isError: true });
    }
    expect(received).toHaveBeenCalledTimes(1);
    const write = { uri: "openclaw-file://one", blob: "AA==", ifMatch: "v1" };
    const saved = await requestRecord(app, "openai/resources/write", write);
    expect(saved).toEqual({ outcome: "saved", etag: "saved-1" });
    expect(writes.mock.calls[0]?.[0]).toEqual(write);
  } finally {
    await close();
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
  const hello = gatewayHelloForMethods(["mcp.app.view"]);
  const navigate = vi.fn();
  const gateway = {
    snapshot: { client, phase: "connected", hello },
    connection: { gatewayUrl: "ws://gateway.example:8443/openclaw" },
    connectionRevision: 1,
    subscribe: () => () => {},
    subscribeEvents: () => () => {},
  };
  mockMcpSandboxProxyReady();
  const { view, unmount } = mountView(
    { sessionKey: "agent:main:one", agentId: "main", viewId: "current-view" },
    { gateway, navigate, theme: { subscribe: () => () => {} } },
  );
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
    gateway.snapshot.hello = { ...hello, auth: { role: "operator", scopes: [] } };
    await refused();
    gateway.snapshot.hello = hello;
  } finally {
    await view.teardown();
    unmount();
    await app.close();
  }
});

it("forwards resource metadata and keeps subscriptions with the extracted bridge lifetime", async () => {
  const { bridge, app, connect, close } = createBridgePair(
    buildMcpAppHostCapabilities(undefined, true, false, { fileResources: true }),
  );
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
  const notifications = bindResources({
    bridge,
    request,
    releaseResourceSubscription: (uri) => request("mcp.app.unsubscribeResource", { uri }),
    iframe: frame,
    fileResourcesSupported: true,
    isDisposed: () => disposed,
    addCleanup: (cleanup) => {
      cleanups.add(cleanup);
    },
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
  await connect();
  notifications.start();
  const emit = (viewId: string, uri: string) => {
    for (const listener of listeners) {
      listener({ type: "event", event: "mcp.app.resourceUpdated", payload: { viewId, uri } });
    }
  };
  const rpc = (method: string, uri: string) => requestRecord(app, method, { uri });
  const one = "openclaw-file://one";
  const two = "openclaw-file://two";
  const lateUri = "openclaw-file://late";
  try {
    const read = await requestRecord(app, "resources/read", {
      uri: one,
      _meta: { "openai/representation": "text" },
    });
    expect(read).toEqual({ contents: [{ uri: one, text: "representation" }] });
    expect(request).toHaveBeenLastCalledWith("mcp.app.readResource", {
      uri: one,
      _meta: { "openai/representation": "text" },
    });
    request.mockResolvedValueOnce({ contents: [{ uri: one, text: 42 }] });
    await expect(rpc("resources/read", one)).rejects.toThrow("Invalid Gateway MCP result");
    request.mockResolvedValueOnce(42);
    await expect(rpc("resources/subscribe", "openclaw-file://malformed")).rejects.toThrow();
    emit("app", "openclaw-file://malformed");
    expect(notification).not.toHaveBeenCalled();
    await rpc("resources/subscribe", one);
    emit("other", one);
    emit("app", "openclaw-file://unknown");
    expect(notification).not.toHaveBeenCalled();
    emit("app", one);
    expect(notification).toHaveBeenCalledExactlyOnceWith({
      method: "notifications/resources/updated",
      params: { uri: one },
    });
    await rpc("resources/unsubscribe", one);
    emit("app", one);
    expect(notification).toHaveBeenCalledTimes(1);
    await rpc("resources/subscribe", two);
    const beforeReconnect = request.mock.calls.length;
    await notifications.reconnect();
    expect(request.mock.calls.slice(beforeReconnect)).toEqual([
      ["mcp.app.subscribeResource", { uri: two }],
    ]);
    const late = rpc("resources/subscribe", lateUri);
    await subscriptionEntered.promise;
    disposed = true;
    for (const cleanup of cleanups) {
      cleanup();
    }
    cleanups.clear();
    expect(listeners.size).toBe(0);
    expect(request).toHaveBeenCalledWith("mcp.app.unsubscribeResource", {
      uri: two,
    });
    subscriptionResult.resolve({});
    await late;
    expect(request).toHaveBeenLastCalledWith("mcp.app.unsubscribeResource", {
      uri: lateUri,
    });
    expect(notification).toHaveBeenCalledTimes(1);
  } finally {
    disposed = true;
    for (const cleanup of cleanups) {
      cleanup();
    }
    await close();
  }
});

it.each(["same", "html", "csp", "sandbox", "input", "capabilities"] as const)(
  "restores a display without authority and handles %s live content",
  async (change) => {
    const cached: McpAppViewPayload = {
      html: "<output>Last board state</output>",
      csp: { connectDomains: ["https://data.example"] },
      sandboxUrl: "/mcp-app-sandbox",
      sandboxPort: 8444,
      toolInput: { period: "week" },
      toolResult: { content: [{ type: "text", text: "cached" }] },
      messageSupported: true,
      updateModelContextSupported: true,
      openFilesSupported: true,
      fileResourcesSupported: true,
    };
    const fresh = {
      ...cached,
      ...(change === "html" ? { html: "<output>Updated app</output>" } : {}),
      ...(change === "csp" ? { csp: { connectDomains: [] } } : {}),
      ...(change === "sandbox" ? { sandboxPort: 8445 } : {}),
      ...(change === "input" ? { toolInput: { period: "month" } } : {}),
      ...(change === "capabilities" ? { messageSupported: false } : {}),
      toolResult: { content: [{ type: "text" as const, text: "live" }] },
    };
    const pairs = [InMemoryTransport.createLinkedPair(), InMemoryTransport.createLinkedPair()];
    const transports = pairs.map(() => createDeferred());
    let next = 0;
    transportMocks.next = () => {
      transports[next]!.resolve();
      return pairs[next++]![0];
    };
    const input = vi.fn();
    const result = createDeferred();
    const updates: unknown[] = [];
    const app = new App({ name: "warm-proof", version: "1" }, {}, { autoResize: false });
    app.ontoolinput = input;
    app.ontoolresult = (value) => {
      updates.push(value);
      result.resolve();
    };
    const client = {
      request: vi.fn(async (method: string) =>
        method === "mcp.app.listTools" ? { tools: [] } : fresh,
      ),
    };
    const gateway = {
      snapshot: { client, phase: "connected", hello: gatewayHelloForMethods(["mcp.app.view"]) },
      connection: { gatewayUrl: "ws://gateway.example:8443/openclaw" },
      connectionRevision: 1,
      subscribe: () => () => {},
      subscribeEvents: vi.fn(() => () => {}),
    };
    mockMcpSandboxProxyReady();
    const display = vi.fn(async () => cached);
    const { view, unmount } = mountView(
      {
        sessionKey: "agent:main:warm",
        widget: boardWidget({ contentKind: "mcp-app" }),
        appDisplay: display,
      },
      { gateway, theme: { subscribe: () => () => {} } },
    );
    let replacement: App | undefined;
    try {
      await transports[0]!.promise;
      await app.connect(pairs[0]![1]);
      await result.promise;
      const frame = view.querySelector("iframe");
      expect(client.request).not.toHaveBeenCalled();
      expect(gateway.subscribeEvents).not.toHaveBeenCalled();
      expect(input).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ arguments: { period: "week" } }),
      );
      for (const [method, params] of [
        ["tools/list", {}],
        ["tools/call", { name: "read" }],
        ["resources/read", { uri: "fixture://state" }],
        ["resources/subscribe", { uri: "fixture://state" }],
        ["resources/unsubscribe", { uri: "fixture://state" }],
        ["openai/resources/write", { uri: "fixture://state", text: "retry" }],
        ["ui/message", { role: "user", content: [{ type: "text", text: "retry me" }] }],
        ["ui/update-model-context", { content: [] }],
        ["ui/open-link", { url: "https://example.com" }],
        ["ui/request-display-mode", { mode: "fullscreen" }],
        ["openai/files/open", { path: "/workspace/state.txt" }],
      ] as const) {
        await expect(requestRecord(app, method, params)).rejects.toThrow("Reconnect and try again");
      }
      expect(client.request).not.toHaveBeenCalled();
      view.viewId = "fresh-live-lease";
      if (change === "same") {
        await waitForSolid(() => expect(updates).toHaveLength(2));
        expect(view.querySelector("iframe")).toBe(frame);
        expect(input).toHaveBeenCalledTimes(1);
        expect(gateway.subscribeEvents).toHaveBeenCalledOnce();
        expect(await requestRecord(app, "tools/list", {})).toEqual({ tools: [] });
        expect(client.request).toHaveBeenLastCalledWith(
          "mcp.app.listTools",
          {
            sessionKey: "agent:main:warm",
            viewId: "fresh-live-lease",
          },
          expect.anything(),
        );
      } else {
        await transports[1]!.promise;
        replacement = new App({ name: "live-proof", version: "1" }, {}, { autoResize: false });
        replacement.ontoolinput = () => {};
        replacement.ontoolresult = () => {};
        await replacement.connect(pairs[1]![1]);
        expect(view.querySelector("iframe")).not.toBe(frame);
        expect(frame?.isConnected).toBe(false);
      }
      expect(client.request).toHaveBeenCalledWith(
        "mcp.app.view",
        {
          sessionKey: "agent:main:warm",
          viewId: "fresh-live-lease",
        },
        expect.anything(),
      );
    } finally {
      await view.teardown();
      unmount();
      await app.close();
      await replacement?.close();
    }
  },
);
