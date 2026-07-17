/* oxlint-disable unicorn/require-post-message-target-origin -- MessagePort has no targetOrigin. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { PluginUiBridgeController } from "./plugin-ui-bridge.ts";

async function connectBridge(
  params: {
    request?: ReturnType<typeof vi.fn>;
    sessionActions?: string[];
    allowChatNavigation?: boolean;
  } = {},
) {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const frameWindow = frame.contentWindow;
  if (!frameWindow) {
    throw new Error("expected iframe window");
  }
  const postMessage = vi.spyOn(frameWindow, "postMessage");
  const request = params.request ?? vi.fn(async () => ({ ok: true }));
  const navigateToChat = vi.fn();
  const bridge = new PluginUiBridgeController();
  bridge.sync({
    frame,
    key: "notes/settings",
    pluginId: "notes",
    client: { request } as unknown as GatewayBrowserClient,
    connected: true,
    sessionKey: "agent:main:active",
    contextTokens: 64_000,
    sessionActions: params.sessionActions ?? ["save"],
    allowChatNavigation: params.allowChatNavigation ?? false,
    navigateToChat,
  });
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { v: 1, type: "openclaw.pluginUi.ready" },
      source: frameWindow,
    }),
  );
  await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
  const [connectMessage, targetOrigin, ports] = postMessage.mock.calls[0] as unknown as [
    Record<string, unknown>,
    string,
    MessagePort[],
  ];
  const childPort = ports[0];
  if (!childPort) {
    throw new Error("expected transferred bridge port");
  }
  const responses: unknown[] = [];
  childPort.addEventListener("message", (event) => responses.push(event.data));
  childPort.start();
  return {
    bridge,
    childPort,
    connectMessage,
    frame,
    navigateToChat,
    request,
    responses,
    postMessage,
    targetOrigin,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("PluginUiBridgeController", () => {
  it("invokes only a declared plugin action with the parent session context", async () => {
    const request = vi.fn(async () => ({ ok: true, result: { saved: true } }));
    const connected = await connectBridge({ request, sessionActions: ["save"] });

    expect(connected.targetOrigin).toBe("*");
    expect(connected.connectMessage).toMatchObject({
      v: 1,
      type: "openclaw.pluginUi.connect",
      capabilities: { sessionActions: ["save"], navigateToChat: false },
      context: { sessionKey: "agent:main:active", contextTokens: 64_000 },
    });
    connected.childPort.postMessage({
      v: 1,
      type: "openclaw.pluginUi.sessionAction",
      id: "save-1",
      actionId: "save",
      sessionKey: "agent:attacker:ignored",
      payload: { enabled: true },
    });

    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith("plugins.sessionAction", {
      pluginId: "notes",
      actionId: "save",
      sessionKey: "agent:main:active",
      contextTokens: 64_000,
      payload: { enabled: true },
    });
    await vi.waitFor(() =>
      expect(connected.responses).toContainEqual({
        v: 1,
        type: "openclaw.pluginUi.response",
        id: "save-1",
        ok: true,
        result: { ok: true, result: { saved: true } },
      }),
    );
    connected.bridge.clear();
    connected.childPort.close();
  });

  it("rejects actions absent from the tab descriptor before Gateway dispatch", async () => {
    const connected = await connectBridge({ sessionActions: ["save"] });
    connected.childPort.postMessage({
      v: 1,
      type: "openclaw.pluginUi.sessionAction",
      id: "delete-1",
      actionId: "delete-everything",
    });

    await vi.waitFor(() => expect(connected.responses).toHaveLength(1));
    expect(connected.request).not.toHaveBeenCalled();
    expect(connected.responses[0]).toMatchObject({
      id: "delete-1",
      ok: false,
      error: "Plugin UI action is not allowed",
    });
    connected.bridge.clear();
    connected.childPort.close();
  });

  it("allows only explicitly enabled chat navigation", async () => {
    const connected = await connectBridge({ allowChatNavigation: true });
    connected.childPort.postMessage({
      v: 1,
      type: "openclaw.pluginUi.navigate",
      id: "navigate-1",
      target: "chat",
      sessionKey: "agent:main:resumed",
    });

    await vi.waitFor(() =>
      expect(connected.navigateToChat).toHaveBeenCalledWith("agent:main:resumed"),
    );
    expect(connected.responses).toContainEqual({
      v: 1,
      type: "openclaw.pluginUi.response",
      id: "navigate-1",
      ok: true,
    });
    connected.bridge.clear();
    connected.childPort.close();
  });

  it("coalesces adjacent frame ready and load connection triggers", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const frameWindow = frame.contentWindow;
    if (!frameWindow) {
      throw new Error("expected iframe window");
    }
    const postMessage = vi.spyOn(frameWindow, "postMessage");
    const bridge = new PluginUiBridgeController();
    bridge.sync({
      frame,
      key: "notes/settings",
      pluginId: "notes",
      client: { request: vi.fn() } as unknown as GatewayBrowserClient,
      connected: true,
      sessionKey: "agent:main:active",
      sessionActions: ["save"],
      allowChatNavigation: false,
      navigateToChat: vi.fn(),
    });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { v: 1, type: "openclaw.pluginUi.ready" },
        source: frameWindow,
      }),
    );
    frame.dispatchEvent(new Event("load"));

    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(postMessage).toHaveBeenCalledOnce();
    bridge.clear();
  });

  it("ignores a repeated ready message after the bridge port is connected", async () => {
    const connected = await connectBridge();
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { v: 1, type: "openclaw.pluginUi.ready" },
        source: connected.frame.contentWindow,
      }),
    );

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(connected.postMessage).toHaveBeenCalledOnce();
    connected.bridge.clear();
    connected.childPort.close();
  });

  it("keeps a ready-connected port across the iframe's late initial load", async () => {
    const connected = await connectBridge();
    connected.frame.dispatchEvent(new Event("load"));

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(connected.postMessage).toHaveBeenCalledOnce();

    connected.frame.dispatchEvent(new Event("load"));
    await vi.waitFor(() => expect(connected.postMessage).toHaveBeenCalledTimes(2));
    connected.bridge.clear();
    connected.childPort.close();
  });

  it("keeps the active port while refreshing its session context and client", async () => {
    const connected = await connectBridge();
    const request = vi.fn(async () => ({ ok: true, result: { saved: true } }));
    connected.bridge.sync({
      frame: connected.frame,
      key: "notes/settings",
      pluginId: "notes",
      client: { request } as unknown as GatewayBrowserClient,
      connected: true,
      sessionKey: "agent:main:refreshed",
      contextTokens: 128_000,
      sessionActions: ["save"],
      allowChatNavigation: false,
      navigateToChat: vi.fn(),
    });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(connected.postMessage).toHaveBeenCalledOnce();
    connected.childPort.postMessage({
      v: 1,
      type: "openclaw.pluginUi.sessionAction",
      id: "save-refreshed",
      actionId: "save",
      payload: { enabled: true },
    });
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("plugins.sessionAction", {
        pluginId: "notes",
        actionId: "save",
        sessionKey: "agent:main:refreshed",
        contextTokens: 128_000,
        payload: { enabled: true },
      }),
    );
    connected.bridge.clear();
    connected.childPort.close();
  });
});
