import { createRouter, definePage } from "@openclaw/uirouter";
import type { CDPSession } from "@vitest/browser-playwright";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cdp } from "vitest/browser";
import {
  CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS,
  CONTROL_UI_PLUGIN_AUTH_PROBE_MESSAGE,
  CONTROL_UI_PLUGIN_AUTH_PROBE_QUERY,
} from "../../../../src/gateway/control-ui-plugin-frame-contract.js";
import { createDeferred, withinTest } from "../../../../test/helpers/promise.ts";
import type { GatewayBrowserClient, GatewayControlUiPluginTab } from "../../api/gateway.ts";
import { createShellConfigFixture } from "../../app/app-host.test-support.ts";
import type { ApplicationConfigCapability } from "../../app/config.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  createApplicationGateway,
  createSolidApplicationContextProvider,
} from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import type { ControlUiPluginSessionOpenMessage } from "./plugin-frame-session-navigation.ts";
import { PluginPage } from "./plugin-page.tsx";

const pluginPath = "/plugins/example/panel";
const externalPath = "https://unrelated.example/panel";
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
        dispatch(node.contentWindow, { type: CONTROL_UI_PLUGIN_AUTH_PROBE_MESSAGE, nonce });
      }
    }
  });
});

afterEach(() =>
  Promise.all(dispose.splice(0).map(async (cleanup) => cleanup())).finally(() =>
    vi.restoreAllMocks(),
  ),
);

type MountOptions = Partial<Pick<GatewayControlUiPluginTab, "requiresGatewayAuth" | "path">> & {
  boardFace?: "dashboard";
  container?: HTMLElement;
};

async function mount(options: MountOptions = {}) {
  const descriptor: GatewayControlUiPluginTab = {
    pluginId: "example-plugin",
    id: "panel",
    label: "Example panel",
    path: options.path ?? pluginPath,
    requiresGatewayAuth: options.requiresGatewayAuth ?? true,
  };
  const config = {
    ...createShellConfigFixture().current,
    embedSandboxMode: "scripts",
    pluginFrameGrants: [
      { pluginId: descriptor.pluginId, path: "/plugins/example", match: "prefix" },
    ],
  } satisfies ApplicationConfigCapability["current"];
  const actions = { setSessionKey: vi.fn(), selectAgent: vi.fn(), navigate: vi.fn() };
  const { gateway: source, publish } = createApplicationGateway();
  const gateway = { ...source, connectionRevision: 1, setSessionKey: actions.setSessionKey };
  const snapshot = gateway.snapshot;
  Object.assign(snapshot, {
    client: { request: vi.fn() } as unknown as GatewayBrowserClient,
    phase: "connected",
    hello: {
      type: "hello-ok",
      protocol: 3,
      auth: { role: "operator", scopes: ["operator.read"] },
      controlUiTabs: [descriptor],
    },
  } satisfies Partial<typeof gateway.snapshot>);
  const rows = options.boardFace ? [{ key: sessionKey, boardFace: options.boardFace }] : [];
  const router = createRouter({
    routes: [definePage({ id: "plugin", path: "/plugin", component: () => ({}) })],
  });
  dispose.push(() => router.stop());
  const refresh = vi.fn(async () => config);
  const context = {
    basePath: "/console",
    gateway,
    config: { current: config, refresh },
    agents: { state: { agentsList: { defaultId: "main", agents: [] } } },
    agentSelection: { state: { selectedId: "main" }, set: actions.selectAgent },
    sessions: { state: { result: { sessions: rows } } },
    navigate: actions.navigate,
    router,
  } as unknown as ApplicationContext;
  const mounted = mountSolid(
    () => <PluginPage pluginId={descriptor.pluginId} tabId={descriptor.id} />,
    {
      container: options.container,
      wrapper: createSolidApplicationContextProvider(context).wrapper,
    },
  );
  const { container, unmount } = mounted;
  dispose.push(unmount);
  await waitForSolid(() => expect(container.querySelector("iframe")).not.toBeNull());
  return {
    ...actions,
    getFrame: () => container.querySelector("iframe"),
    frame: container.querySelector("iframe")!,
    descriptor,
    gateway,
    snapshot,
    refresh,
    unmount,
    notify: () => publish(snapshot),
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

async function mountClickableFrame(signal: AbortSignal) {
  const container = document.body.appendChild(document.createElement("div"));
  dispose.push(() => container.remove());
  signal.throwIfAborted();
  const session: CDPSession = cdp();
  // Vitest initializes its CDP handler lazily; finish that before listener and command RPCs race.
  await session.send("Page.enable");
  const ready = createDeferred();
  const onReady = (event: MessageEvent<unknown>) => {
    const frame = container.querySelector("iframe");
    if (frame && event.source === frame.contentWindow && event.data === "test-click-ready") {
      ready.resolve();
    }
  };
  const clickHtml = `<button id="open">Open work session</button><script>
    document.getElementById("open").onclick = () => parent.postMessage(${JSON.stringify(message)}, ${JSON.stringify(window.location.origin)});
    addEventListener("message", event => {
      if (event.source === parent && event.data === "test-click") document.getElementById("open").click();
    });
    parent.postMessage("test-click-ready", ${JSON.stringify(window.location.origin)});
  </script>`;
  const onRequest = ({ requestId }: { requestId: string }) => {
    void session
      .send("Fetch.fulfillRequest", {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
        body: btoa(clickHtml),
      })
      .catch(ready.reject);
  };
  dispose.push(async () => {
    window.removeEventListener("message", onReady);
    session.off("Fetch.requestPaused", onRequest);
    await session.send("Fetch.disable");
  });
  window.addEventListener("message", onReady);
  session.on("Fetch.requestPaused", onRequest);
  // Own the initial document; replacing srcdoc after mount races Vite's SPA fallback navigation.
  await session.send("Fetch.enable", {
    patterns: [
      { urlPattern: new URL(pluginPath, window.location.href).href, resourceType: "Document" },
    ],
  });
  signal.throwIfAborted();
  const [fixture] = await withinTest(Promise.all([mount({ container }), ready.promise]), signal);
  return fixture;
}

it("routes a sandbox-frame click with the base path and selection order", async ({ signal }) => {
  const { frame, navigate, selectAgent, setSessionKey } = await mountClickableFrame(signal);
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  frame.contentWindow!.postMessage("test-click", "*");
  await waitForSolid(() => expect(navigate.mock.calls.length).toBe(1));
  expect(selectAgent).toHaveBeenCalledExactlyOnceWith("writer");
  expect(setSessionKey).toHaveBeenCalledExactlyOnceWith(sessionKey);
  expect(selectAgent.mock.invocationCallOrder[0]).toBeLessThan(
    setSessionKey.mock.invocationCallOrder[0]!,
  );
  expect(navigate).toHaveBeenCalledExactlyOnceWith("chat", {
    pathname: "/console/chat/writer/subagent/11111111-2222-4333-8444-555555555555",
    search: "?__openclawSessionFacePreference=1",
  });
});

it("preserves the existing preferred face and explicit global owner", async () => {
  const { frame, navigate, selectAgent, setSessionKey } = await mount({ boardFace: "dashboard" });
  dispatch(frame.contentWindow, message, window.location.origin);
  expect(navigate).toHaveBeenLastCalledWith("dashboard", {
    pathname: "/console/dashboard/writer/subagent/11111111-2222-4333-8444-555555555555",
    search: undefined,
  });
  dispatch(frame.contentWindow, { ...message, sessionKey: "global", agentId: "research" });
  expect(selectAgent).toHaveBeenLastCalledWith("research");
  expect(setSessionKey).toHaveBeenLastCalledWith("global");
  expect(navigate).toHaveBeenLastCalledWith("chat", {
    pathname: "/console/chat/research",
    search: "?__openclawSessionFacePreference=1",
  });
});

it("rejects other windows, wrong origins, response channels, and malformed requests", async () => {
  const { frame, navigate, selectAgent, setSessionKey } = await mount();
  dispatch(frame.contentWindow, message, "https://unrelated.example");
  const other = document.createElement("iframe");
  document.body.append(other);
  dispatch(other.contentWindow);
  other.remove();
  const channel = new MessageChannel();
  dispatch(frame.contentWindow, message, "null", [channel.port1]);
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
    dispatch(frame.contentWindow, invalid);
  }
  expect([navigate, selectAgent, setSessionKey].map((fn) => fn.mock.calls)).toEqual([[], [], []]);
  dispatch(frame.contentWindow);
  expect(navigate).toHaveBeenCalledOnce();
});

it("rejects live descriptor, scope, client, and grant changes before a render", async () => {
  const { frame, snapshot, descriptor, gateway, navigate, setSessionKey } = await mount();
  const hello = snapshot.hello!;
  function dispatchWith<T, K extends keyof T>(target: T, key: K, value: T[K]) {
    const original = target[key];
    target[key] = value;
    dispatch(frame.contentWindow);
    target[key] = original;
  }
  dispatchWith(hello, "controlUiTabs", []);
  dispatchWith(descriptor, "path", externalPath);
  dispatchWith(descriptor, "path", "/plugins/example/other");
  dispatchWith(descriptor, "requiresGatewayAuth", false);
  dispatchWith(hello, "auth", { role: "operator", scopes: ["operator.approvals"] });
  dispatchWith(snapshot, "phase", "reconnecting");
  dispatchWith(snapshot, "client", { request: vi.fn() } as unknown as GatewayBrowserClient);
  dispatchWith(gateway, "connectionRevision", gateway.connectionRevision + 1);
  dispatchWith(snapshot, "hello", { ...hello });
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS + 1);
  dispatch(frame.contentWindow);
  expect([navigate, setSessionKey].map((fn) => fn.mock.calls)).toEqual([[], []]);
});

it.each(["reconnect", "descriptor"] as const)("retires %s frames", async (change) => {
  const fixture = await mount();
  const staleWindow = fixture.frame.contentWindow;
  if (change === "reconnect") {
    fixture.snapshot.phase = "reconnecting";
    fixture.notify();
    flush();
    expect(fixture.getFrame()).toBeNull();
    fixture.snapshot.phase = "connected";
    fixture.notify();
    dispatch(staleWindow);
    expect(fixture.navigate).not.toHaveBeenCalled();
    await waitForSolid(() => {
      const frame = fixture.getFrame();
      expect(frame !== null && frame !== fixture.frame).toBe(true);
    });
    expect(fixture.refresh).toHaveBeenCalledTimes(2);
  } else {
    for (const path of ["/plugins/example/other", pluginPath]) {
      fixture.descriptor.path = path;
      fixture.notify();
      await waitForSolid(() => expect(fixture.getFrame()?.getAttribute("src")).toBe(path));
    }
  }
  const currentFrame = fixture.getFrame()!;
  expect(currentFrame).not.toBe(fixture.frame);
  dispatch(staleWindow);
  expect(fixture.navigate).not.toHaveBeenCalled();
  dispatch(currentFrame.contentWindow);
  expect(fixture.navigate).toHaveBeenCalledOnce();
  const currentWindow = currentFrame.contentWindow;
  fixture.unmount();
  dispatch(currentWindow);
  expect(fixture.navigate).toHaveBeenCalledOnce();
});

it.each([pluginPath, externalPath])("denies unauthenticated %s", async (path) => {
  const { frame, navigate } = await mount({ requiresGatewayAuth: false, path });
  dispatch(frame.contentWindow);
  expect(navigate).not.toHaveBeenCalled();
});
