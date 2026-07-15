/* oxlint-disable unicorn/require-post-message-target-origin -- MessagePort has no targetOrigin. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginUiBridgeController } from "./plugin-ui-bridge.ts";

function connectBridge(fetchImpl: typeof fetch = vi.fn()) {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  if (!frame.contentWindow) {
    throw new Error("expected iframe window");
  }
  const bridge = new PluginUiBridgeController(fetchImpl);
  bridge.sync({
    frame,
    key: "notes/settings",
    pluginId: "notes",
    src: "/plugins/notes?openclaw-entry=token",
  });
  const bridgeToken = new URLSearchParams(new URL(frame.src).hash.slice(1)).get(
    "openclaw-plugin-ui-bridge",
  );
  const targetWindow = frame.contentWindow;
  if (!bridgeToken || !targetWindow) {
    throw new Error("expected launched iframe and bridge token");
  }
  const channel = new MessageChannel();
  const childPort = channel.port1;
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { v: 1, type: "openclaw.pluginUi.init", token: bridgeToken },
      source: targetWindow,
      ports: [channel.port2],
    }),
  );
  const responses: unknown[] = [];
  childPort.addEventListener("message", (event) => responses.push(event.data));
  childPort.start();
  return { bridge, bridgeToken, childPort, frame, responses };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("PluginUiBridgeController", () => {
  it("proxies a plugin-owned request through the authenticated parent", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const connected = connectBridge(fetchImpl as typeof fetch);
    expect(connected.frame.getAttribute("src")).toMatch(
      /^\/plugins\/notes\?openclaw-entry=token#openclaw-plugin-ui-bridge=/,
    );

    connected.childPort.postMessage({
      v: 1,
      type: "openclaw.pluginUi.request",
      id: "req-1",
      path: "/plugins/notes/api/settings",
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer must-not-forward",
          cookie: "must-not-forward=1",
        },
        body: '{"enabled":true}',
      },
    });

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    const [path, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/plugins/notes/api/settings");
    expect(init).toMatchObject({
      method: "POST",
      body: '{"enabled":true}',
      credentials: "same-origin",
      redirect: "error",
    });
    const headers = init.headers as Headers;
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
    await vi.waitFor(() =>
      expect(connected.responses).toContainEqual(
        expect.objectContaining({
          type: "openclaw.pluginUi.response",
          v: 1,
          id: "req-1",
          ok: true,
          status: 200,
          body: '{"ok":true}',
        }),
      ),
    );
    connected.bridge.clear();
    connected.childPort.close();
  });

  it.each([
    ["cross-plugin", "/plugins/other/api/settings"],
    ["encoded traversal", "/plugins/notes/%252e%252e/other/api/settings"],
    ["external origin", "https://example.com/plugins/notes/api/settings"],
  ])("rejects %s requests before fetch", async (_name, path) => {
    const fetchImpl = vi.fn();
    const connected = connectBridge(fetchImpl as typeof fetch);
    connected.childPort.postMessage({
      v: 1,
      type: "openclaw.pluginUi.request",
      id: "bad-request",
      path,
    });

    await vi.waitFor(() => expect(connected.responses).toHaveLength(1));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(connected.responses[0]).toMatchObject({
      id: "bad-request",
      ok: false,
      status: 400,
    });
    connected.bridge.clear();
    connected.childPort.close();
  });

  it("rejects bootstrap attempts from the wrong document or token", async () => {
    const fetchImpl = vi.fn();
    const frame = document.createElement("iframe");
    const foreignFrame = document.createElement("iframe");
    document.body.append(frame, foreignFrame);
    const bridge = new PluginUiBridgeController(fetchImpl as typeof fetch);
    bridge.sync({ frame, key: "notes/settings", pluginId: "notes", src: "/plugins/notes" });
    const bridgeToken = new URLSearchParams(new URL(frame.src).hash.slice(1)).get(
      "openclaw-plugin-ui-bridge",
    );
    const wrongSource = new MessageChannel();
    const wrongToken = new MessageChannel();
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { v: 1, type: "openclaw.pluginUi.init", token: bridgeToken },
        source: foreignFrame.contentWindow,
        ports: [wrongSource.port2],
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { v: 1, type: "openclaw.pluginUi.init", token: "wrong-token" },
        source: frame.contentWindow,
        ports: [wrongToken.port2],
      }),
    );
    for (const port of [wrongSource.port1, wrongToken.port1]) {
      port.postMessage({
        v: 1,
        type: "openclaw.pluginUi.request",
        id: "rejected",
        path: "/plugins/notes/api/settings",
      });
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    bridge.clear();
    wrongSource.port1.close();
    wrongToken.port1.close();
  });

  it("rejects a replacement document bootstrap after connecting", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));
    const connected = connectBridge(fetchImpl as typeof fetch);
    const replacement = new MessageChannel();
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { v: 1, type: "openclaw.pluginUi.init", token: connected.bridgeToken },
        source: connected.frame.contentWindow,
        ports: [replacement.port2],
      }),
    );
    replacement.port1.postMessage({
      v: 1,
      type: "openclaw.pluginUi.request",
      id: "replacement",
      path: "/plugins/notes/api/settings",
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    connected.bridge.clear();
    connected.childPort.close();
    replacement.port1.close();
  });

  it("requests a fresh launch after the connected iframe reloads", () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    if (!frame.contentWindow) {
      throw new Error("expected iframe window");
    }
    const onReload = vi.fn();
    const bridge = new PluginUiBridgeController(vi.fn());
    bridge.sync({
      frame,
      key: "notes/settings",
      onReload,
      pluginId: "notes",
      src: "/plugins/notes?openclaw-entry=token",
    });
    const bridgeToken = new URLSearchParams(new URL(frame.src).hash.slice(1)).get(
      "openclaw-plugin-ui-bridge",
    );
    const channel = new MessageChannel();
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { v: 1, type: "openclaw.pluginUi.init", token: bridgeToken },
        source: frame.contentWindow,
        ports: [channel.port2],
      }),
    );

    frame.dispatchEvent(new Event("load"));
    expect(onReload).not.toHaveBeenCalled();
    frame.dispatchEvent(new Event("load"));
    expect(onReload).toHaveBeenCalledOnce();

    bridge.clear();
    channel.port1.close();
  });
});
