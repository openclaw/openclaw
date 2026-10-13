import type { CDPSession } from "@vitest/browser-playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cdp } from "vitest/browser";
import {
  CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS,
  CONTROL_UI_PLUGIN_AUTH_PROBE_MESSAGE,
  CONTROL_UI_PLUGIN_AUTH_PROBE_QUERY,
} from "../../../../src/gateway/control-ui-plugin-frame-contract.js";
import { createDeferred, withinTest } from "../../../../test/helpers/promise.ts";
import type { GatewayBrowserClient, GatewayControlUiPluginTab } from "../../api/gateway.ts";
import type { ApplicationConfigCapability } from "../../app/config.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import type { ControlUiPluginSessionOpenMessage } from "./plugin-frame-session-navigation.ts";
import { PluginPage } from "./plugin-page.tsx";

const pluginPath = "/plugins/example/panel";
const sessionKey = "agent:writer:subagent:11111111-2222-4333-8444-555555555555";
const message: ControlUiPluginSessionOpenMessage = {
  type: "openclaw-plugin-session-open",
  sessionKey,
};
const dispose: Array<() => void | Promise<void>> = [];

beforeEach(() => {
  const append = document.body.append.bind(document.body);
  vi.spyOn(document.body, "append").mockImplementation((...nodes) => {
    append(...nodes);
    for (const node of nodes) {
      if (!(node instanceof HTMLIFrameElement) || !node.hidden) {
        continue;
      }
      const nonce = new URL(node.src).searchParams.get(CONTROL_UI_PLUGIN_AUTH_PROBE_QUERY);
      if (nonce) {
        // Deliver the probe document's response through the real source/nonce boundary.
        dispatch(node.contentWindow, { type: CONTROL_UI_PLUGIN_AUTH_PROBE_MESSAGE, nonce });
      }
    }
  });
});

afterEach(async () => {
  try {
    await Promise.all(dispose.splice(0).map(async (cleanup) => cleanup()));
  } finally {
    cleanupSolid();
    vi.restoreAllMocks();
  }
});

async function mount(
  options: {
    requiresGatewayAuth?: boolean;
    path?: string;
    boardFace?: "dashboard";
    sessionActions?: string[];
    container?: HTMLElement;
  } = {},
) {
  const descriptor: GatewayControlUiPluginTab = {
    pluginId: "example-plugin",
    id: "panel",
    label: "Example panel",
    path: options.path ?? pluginPath,
    requiresGatewayAuth: options.requiresGatewayAuth ?? true,
    sessionActions: options.sessionActions,
  };
  const config = {
    assistantIdentity: {
      agentId: null,
      name: "Assistant",
      avatar: null,
      avatarSource: null,
      avatarStatus: null,
      avatarReason: null,
    },
    serverVersion: null,
    devGitBranch: null,
    environment: null,
    embedSandboxMode: "scripts",
    allowExternalEmbedUrls: false,
    automaticallyFetchFavicons: false,
    communityInvite: false,
    terminalEnabled: false,
    uploadsEnabled: true,
    pluginAssetsRequireAuth: true,
    pluginControlUiModules: [],
    pluginFrameGrants: [
      { pluginId: descriptor.pluginId, path: "/plugins/example", match: "prefix" },
    ],
  } satisfies ApplicationConfigCapability["current"];
  const snapshot: ApplicationGatewaySnapshot = {
    client: { request: vi.fn() } as unknown as GatewayBrowserClient,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: {
      type: "hello-ok",
      protocol: 3,
      auth: { role: "operator", scopes: ["operator.read"] },
      controlUiTabs: [descriptor],
    },
    assistantAgentId: "main",
    sessionKey: "agent:main:main",
    lastError: null,
    lastErrorCode: null,
  };
  const listeners = new Set<() => void>();
  const setSessionKey = vi.fn();
  const selectAgent = vi.fn();
  const navigate = vi.fn();
  const gateway = {
    snapshot,
    connectionRevision: 1,
    setSessionKey,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const context = {
    basePath: "/console",
    gateway,
    config: { current: config, refresh: vi.fn(async () => config) },
    agents: { state: { agentsList: { defaultId: "main", agents: [] } } },
    agentSelection: { state: { selectedId: "main" }, set: selectAgent },
    sessions: {
      state: {
        result: {
          sessions: options.boardFace ? [{ key: sessionKey, boardFace: options.boardFace }] : [],
        },
      },
      subscribe: () => () => undefined,
    },
    navigate,
  } as unknown as ApplicationContext;
  const container = options.container ?? document.createElement("div");
  document.body.append(container);
  const provider = createSolidApplicationContextProvider(context);
  const mounted = mountSolid(
    () => <PluginPage pluginId={descriptor.pluginId} tabId={descriptor.id} />,
    { container, wrapper: provider.wrapper },
  );
  const unmount = () => {
    mounted.unmount();
    container.remove();
  };
  dispose.push(unmount);
  flush();
  await waitForSolid(() => expect(container.querySelector("iframe")).not.toBeNull());
  const view = container.querySelector<HTMLElement>("openclaw-plugin-page")!;
  const frame = view.querySelector("iframe")!;
  return {
    view,
    frame,
    descriptor,
    gateway,
    snapshot,
    setSessionKey,
    selectAgent,
    navigate,
    unmount,
    notify: () => listeners.forEach((listener) => listener()),
  };
}

function dispatch(
  source: Window | null,
  data: unknown = message,
  origin = "null",
  ports: MessagePort[] = [],
) {
  window.dispatchEvent(new MessageEvent("message", { source, data, origin, ports }));
}

async function prepareClickDocument(view: HTMLElement, signal: AbortSignal) {
  signal.throwIfAborted();
  const session: CDPSession = cdp();
  // Vitest initializes its CDP handler lazily; finish that before listener and command RPCs race.
  await session.send("Page.enable");
  const ready = createDeferred();
  const loaded = createDeferred();
  const documentVerified = createDeferred();
  let proofPort: MessagePort | undefined;
  const onLoad = (event: Event) => {
    if (event.target === view.querySelector("iframe")) {
      loaded.resolve();
      view.removeEventListener("load", onLoad, true);
    }
  };
  view.addEventListener("load", onLoad, true);
  dispose.push(() => view.removeEventListener("load", onLoad, true));
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      window.removeEventListener("message", onReady);
      signal.removeEventListener("abort", onAbort);
      session.off("Fetch.requestPaused", onRequest);
      await session.send("Fetch.disable");
    })());
  const fail = (error: unknown) => {
    void cleanup().then(
      () => ready.reject(new Error("Plugin click document failed", { cause: error })),
      (cleanupError: unknown) =>
        ready.reject(new Error("Plugin click document cleanup failed", { cause: cleanupError })),
    );
  };
  const onReady = (event: MessageEvent<unknown>) => {
    const frame = view.querySelector("iframe");
    if (frame && event.source === frame.contentWindow && event.ports.length === 2) {
      proofPort = event.ports[1];
    }
    if (frame && event.source === frame.contentWindow && event.data === "test-click-ready") {
      // The connection is established: observe replies after the production listener,
      // so awaiting this event also waits for the real navigation decision.
      const onProof = (proof: MessageEvent) => {
        if (proof.data?.type === "openclaw.pluginUi.documentVerified") {
          documentVerified.resolve();
        }
      };
      proofPort?.addEventListener("message", onProof);
      dispose.push(() => proofPort?.removeEventListener("message", onProof));
      void cleanup().then(() => ready.resolve(), fail);
    }
  };
  const onAbort = () => fail(new Error("Iframe readiness aborted", { cause: signal.reason }));
  const clickHtml = `<button id="open">Open work session</button><script>
    document.getElementById("open").onclick = () => parent.postMessage(${JSON.stringify(message)}, ${JSON.stringify(window.location.origin)});
    addEventListener("message", event => {
      if (event.source === parent && event.data === "test-click") document.getElementById("open").click();
      if (event.source === parent && event.data === "test-replace") location.href = "/plugins/example/replacement";
    });
    const ready = () => parent.postMessage("test-click-ready", ${JSON.stringify(window.location.origin)});
    if (window.openclawPluginUiBridge) window.openclawPluginUiBridge.connected.then(ready);
    else ready();
  </script>`;
  const onRequest = ({ requestId }: { requestId: string }) => {
    void session
      .send("Fetch.fulfillRequest", {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
        body: btoa(clickHtml),
      })
      .catch(fail);
  };
  dispose.push(cleanup);
  window.addEventListener("message", onReady);
  session.on("Fetch.requestPaused", onRequest);
  try {
    // Own the initial document; replacing srcdoc after mount races Vite's SPA fallback navigation.
    await session.send("Fetch.enable", {
      // Action-capable tabs fetch this HTML in the parent before rendering srcdoc.
      patterns: [{ urlPattern: new URL(pluginPath, window.location.href).href }],
    });
    signal.throwIfAborted();
  } catch (error) {
    await cleanup();
    throw new Error("Could not prepare plugin click document", { cause: error });
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return {
    ready: ready.promise,
    loaded: loaded.promise,
    documentVerified: documentVerified.promise,
  };
}

async function prepareReplacementDocument(frame: HTMLIFrameElement, signal: AbortSignal) {
  const session: CDPSession = cdp();
  await session.send("Page.enable");
  const replacementUrl = new URL("/plugins/example/replacement", window.location.href).href;
  const imageUrl = new URL("/plugins/example/held-image", window.location.href).href;
  const sent = createDeferred();
  const heldImage = createDeferred<string>();
  const loaded = createDeferred();
  const onLoad = vi.fn(() => loaded.resolve());
  const onMessage = (event: MessageEvent) => {
    if (event.source === frame.contentWindow && event.data === "test-replacement-sent") {
      sent.resolve();
    }
  };
  const replacementHtml = `<img src="${imageUrl}"><script>
    parent.postMessage(${JSON.stringify(message)}, ${JSON.stringify(window.location.origin)});
    // Same-source window messages are FIFO: the host has handled the request at this barrier.
    parent.postMessage("test-replacement-sent", ${JSON.stringify(window.location.origin)});
  </script>`;
  const onRequest = ({ requestId, request }: { requestId: string; request: { url: string } }) => {
    if (request.url === imageUrl) {
      heldImage.resolve(requestId);
      return;
    }
    void session
      .send("Fetch.fulfillRequest", {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
        body: btoa(replacementHtml),
      })
      .catch((error: unknown) => sent.reject(error));
  };
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      frame.removeEventListener("load", onLoad);
      window.removeEventListener("message", onMessage);
      session.off("Fetch.requestPaused", onRequest);
      await session.send("Fetch.disable");
    })());
  dispose.push(cleanup);
  frame.addEventListener("load", onLoad);
  window.addEventListener("message", onMessage);
  session.on("Fetch.requestPaused", onRequest);
  await session.send("Fetch.enable", {
    patterns: [{ urlPattern: replacementUrl }, { urlPattern: imageUrl }],
  });
  signal.throwIfAborted();
  return {
    sent: sent.promise,
    heldImage: heldImage.promise,
    onLoad,
    release: async () => {
      await session.send("Fetch.fulfillRequest", {
        requestId: await withinTest(heldImage.promise, signal),
        responseCode: 204,
      });
      await withinTest(loaded.promise, signal);
      await cleanup();
    },
  };
}

describe("authenticated plugin-frame session navigation", () => {
  it("routes a real sandbox-frame click with the canonical base path and ordered selection", async ({
    signal,
  }) => {
    const container = document.createElement("div");
    const clickDocument = await prepareClickDocument(container, signal);
    const [fixture] = await Promise.all([mount({ container }), clickDocument.ready]);
    expect(fixture.frame.getAttribute("sandbox")).toBe("allow-scripts");
    fixture.frame.contentWindow!.postMessage("test-click", "*");
    await waitForSolid(() => expect(fixture.navigate.mock.calls.length).toBe(1));
    expect(fixture.selectAgent).toHaveBeenCalledExactlyOnceWith("writer");
    expect(fixture.setSessionKey).toHaveBeenCalledExactlyOnceWith(sessionKey);
    expect(fixture.selectAgent.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.setSessionKey.mock.invocationCallOrder[0]!,
    );
    expect(fixture.navigate).toHaveBeenCalledExactlyOnceWith("chat", {
      pathname: "/console/chat/writer/subagent/11111111-2222-4333-8444-555555555555",
      search: "?__openclawSessionFacePreference=1",
    });
  });

  it("preserves the existing preferred face and explicit global owner", async () => {
    const fixture = await mount({ boardFace: "dashboard" });
    dispatch(fixture.frame.contentWindow, message, window.location.origin);
    expect(fixture.navigate).toHaveBeenLastCalledWith("dashboard", {
      pathname: "/console/dashboard/writer/subagent/11111111-2222-4333-8444-555555555555",
      search: undefined,
    });
    dispatch(fixture.frame.contentWindow, {
      ...message,
      sessionKey: "global",
      agentId: "research",
    });
    expect(fixture.selectAgent).toHaveBeenLastCalledWith("research");
    expect(fixture.setSessionKey).toHaveBeenLastCalledWith("global");
    expect(fixture.navigate).toHaveBeenLastCalledWith("chat", {
      pathname: "/console/chat/research",
      search: "?__openclawSessionFacePreference=1",
    });
  });

  it("preserves legacy session navigation and the preferred dashboard for an action-capable srcdoc", async ({
    signal,
  }) => {
    const container = document.createElement("div");
    const clickDocument = await prepareClickDocument(container, signal);
    const [fixture] = await Promise.all([
      mount({ container, boardFace: "dashboard", sessionActions: ["save"] }),
      clickDocument.ready,
    ]);
    expect(fixture.frame.hasAttribute("srcdoc")).toBe(true);
    expect(fixture.frame.getAttribute("src")).toBeNull();
    expect(fixture.frame.getAttribute("sandbox")).toBe("allow-scripts");
    fixture.frame.contentWindow!.postMessage("test-click", "*");
    await withinTest(clickDocument.documentVerified, signal);
    expect(fixture.selectAgent).toHaveBeenCalledExactlyOnceWith("writer");
    expect(fixture.setSessionKey).toHaveBeenCalledExactlyOnceWith(sessionKey);
    expect(fixture.navigate).toHaveBeenCalledExactlyOnceWith("dashboard", {
      pathname: "/console/dashboard/writer/subagent/11111111-2222-4333-8444-555555555555",
      search: undefined,
    });
  });

  it("rejects a replacement document's legacy request before its iframe load can revoke the bridge", async ({
    signal,
  }) => {
    const container = document.createElement("div");
    const clickDocument = await prepareClickDocument(container, signal);
    const [fixture] = await Promise.all([
      mount({ container, sessionActions: ["save"] }),
      clickDocument.ready,
      clickDocument.loaded,
    ]);
    const originalWindow = fixture.frame.contentWindow;
    originalWindow!.postMessage("test-click", "*");
    await withinTest(clickDocument.documentVerified, signal);
    expect(fixture.navigate).toHaveBeenCalledOnce();
    fixture.navigate.mockClear();
    fixture.selectAgent.mockClear();
    fixture.setSessionKey.mockClear();

    const replacement = await prepareReplacementDocument(fixture.frame, signal);
    originalWindow!.postMessage("test-replace", "*");
    await withinTest(Promise.all([replacement.sent, replacement.heldImage]), signal);
    expect(fixture.frame.contentWindow).toBe(originalWindow);
    expect(replacement.onLoad).not.toHaveBeenCalled();
    expect(fixture.navigate).not.toHaveBeenCalled();
    await replacement.release();
    expect(replacement.onLoad).toHaveBeenCalledOnce();
    expect(fixture.navigate).not.toHaveBeenCalled();
    expect(fixture.selectAgent).not.toHaveBeenCalled();
    expect(fixture.setSessionKey).not.toHaveBeenCalled();
  });

  it("rejects a real document proof delivered after the gateway connection epoch retires", async ({
    signal,
  }) => {
    const container = document.createElement("div");
    const clickDocument = await prepareClickDocument(container, signal);
    const [fixture] = await Promise.all([
      mount({ container, sessionActions: ["save"] }),
      clickDocument.ready,
    ]);
    const retireConnection = (event: MessageEvent) => {
      if (event.source === fixture.frame.contentWindow && event.data?.type === message.type) {
        // The request handler posts the proof synchronously; the reply is a later port task.
        queueMicrotask(() => {
          fixture.gateway.connectionRevision += 1;
        });
      }
    };
    window.addEventListener("message", retireConnection);
    dispose.push(() => window.removeEventListener("message", retireConnection));
    fixture.frame.contentWindow!.postMessage("test-click", "*");
    await withinTest(clickDocument.documentVerified, signal);
    expect(fixture.gateway.connectionRevision).toBe(2);
    expect(fixture.navigate).not.toHaveBeenCalled();
    expect(fixture.selectAgent).not.toHaveBeenCalled();
    expect(fixture.setSessionKey).not.toHaveBeenCalled();
  });

  it("rejects other windows, wrong origins, response channels, and malformed requests", async () => {
    const fixture = await mount();
    dispatch(window);
    dispatch(null);
    dispatch(fixture.frame.contentWindow, message, "https://unrelated.example");
    const other = document.createElement("iframe");
    document.body.append(other);
    dispatch(other.contentWindow);
    other.remove();
    const channel = new MessageChannel();
    dispatch(fixture.frame.contentWindow, message, "null", [channel.port1]);
    channel.port1.close();
    channel.port2.close();
    for (const invalid of [
      null,
      [],
      "openclaw-plugin-session-open",
      {},
      { ...message, type: "openclaw-session-open" },
      { ...message, sessionKey: 1 },
      { ...message, sessionKey: "" },
      { ...message, sessionKey: " " },
      { ...message, sessionKey: " agent:writer:main" },
      { ...message, sessionKey: "x".repeat(513) },
      { ...message, sessionKey: "agent:writer:bad\nkey" },
      { ...message, sessionKey: "\ud800" },
      { ...message, sessionKey: "agent:writer:" },
      { ...message, sessionKey: "agent:writer::main" },
      { ...message, sessionKey: "https://unrelated.example" },
      { ...message, sessionKey: "agent:../writer:main" },
      { ...message, agentId: null },
      { ...message, agentId: "" },
      { ...message, agentId: "../writer" },
      { ...message, agentId: " writer " },
      { ...message, agentId: "other-agent" },
      { ...message, url: "https://unrelated.example" },
      { ...message, prompt: "Do not run" },
    ]) {
      dispatch(fixture.frame.contentWindow, invalid);
    }
    expect(fixture.navigate).not.toHaveBeenCalled();
    expect(fixture.selectAgent).not.toHaveBeenCalled();
    expect(fixture.setSessionKey).not.toHaveBeenCalled();
    dispatch(fixture.frame.contentWindow);
    expect(fixture.navigate).toHaveBeenCalledOnce();
  });

  it("rejects live descriptor, scope, client, and grant changes before a render", async () => {
    const fixture = await mount();
    const hello = fixture.snapshot.hello!;
    hello.controlUiTabs = [];
    dispatch(fixture.frame.contentWindow);
    hello.controlUiTabs = [fixture.descriptor];
    fixture.descriptor.path = "https://unrelated.example/panel";
    dispatch(fixture.frame.contentWindow);
    fixture.descriptor.path = "/plugins/example/other";
    dispatch(fixture.frame.contentWindow);
    fixture.descriptor.path = "/plugins/example/panel";
    fixture.descriptor.requiresGatewayAuth = false;
    dispatch(fixture.frame.contentWindow);
    fixture.descriptor.requiresGatewayAuth = true;
    hello.auth = { role: "operator", scopes: ["operator.approvals"] };
    dispatch(fixture.frame.contentWindow);
    hello.auth = { role: "operator", scopes: ["operator.read"] };
    fixture.snapshot.phase = "reconnecting";
    dispatch(fixture.frame.contentWindow);
    fixture.snapshot.phase = "connected";
    const client = fixture.snapshot.client;
    fixture.snapshot.client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    dispatch(fixture.frame.contentWindow);
    fixture.snapshot.client = client;
    fixture.gateway.connectionRevision += 1;
    dispatch(fixture.frame.contentWindow);
    fixture.gateway.connectionRevision -= 1;
    fixture.snapshot.hello = { ...hello };
    dispatch(fixture.frame.contentWindow);
    fixture.snapshot.hello = hello;
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS + 1);
    dispatch(fixture.frame.contentWindow);
    expect(fixture.navigate).not.toHaveBeenCalled();
    expect(fixture.setSessionKey).not.toHaveBeenCalled();
  });

  it.each(["reconnect", "descriptor"] as const)(
    "retires a frame across %s replacement and unmount",
    async (change) => {
      const fixture = await mount();
      const staleWindow = fixture.frame.contentWindow;
      if (change === "reconnect") {
        fixture.snapshot.phase = "reconnecting";
        fixture.notify();
        fixture.snapshot.phase = "connected";
        fixture.notify();
        dispatch(staleWindow);
        expect(fixture.navigate).not.toHaveBeenCalled();
        await waitForSolid(() => {
          const frame = fixture.view.querySelector("iframe");
          expect(frame !== null && frame !== fixture.frame).toBe(true);
        });
      } else {
        for (const path of ["/plugins/example/other", pluginPath]) {
          fixture.descriptor.path = path;
          fixture.notify();
          flush();
          await waitForSolid(() =>
            expect(fixture.view.querySelector("iframe")?.getAttribute("src")).toBe(path),
          );
        }
      }
      flush();
      const currentFrame = fixture.view.querySelector("iframe")!;
      expect(currentFrame).not.toBe(fixture.frame);
      dispatch(staleWindow);
      expect(fixture.navigate).not.toHaveBeenCalled();
      dispatch(currentFrame.contentWindow);
      expect(fixture.navigate).toHaveBeenCalledOnce();
      const currentWindow = currentFrame.contentWindow;
      fixture.unmount();
      dispatch(currentWindow);
      expect(fixture.navigate).toHaveBeenCalledOnce();
    },
  );

  it("never lends navigation to an unauthenticated or external descriptor", async () => {
    const local = await mount({ requiresGatewayAuth: false });
    dispatch(local.frame.contentWindow);
    expect(local.navigate).not.toHaveBeenCalled();
    const external = await mount({
      requiresGatewayAuth: false,
      path: "https://unrelated.example/panel",
    });
    dispatch(external.frame.contentWindow);
    expect(external.navigate).not.toHaveBeenCalled();
  });
});
