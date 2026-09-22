import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS } from "../../../../src/gateway/control-ui-plugin-frame-contract.js";
import type { GatewayBrowserClient, GatewayControlUiPluginTab } from "../../api/gateway.ts";
import type { ApplicationConfigCapability } from "../../app/config.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import type { ControlUiPluginSessionOpenMessage } from "./plugin-frame-session-navigation.ts";
import { PluginPage } from "./plugin-page.ts";

class SessionNavigationPluginPage extends PluginPage {
  protected override probeExternalTabAuth(): Promise<boolean> {
    // The existing auth suite owns cookie probes. This suite exercises the actual
    // mounted frame, window-message listener, route builder, and selection owner.
    return Promise.resolve(true);
  }
}

const tag = "openclaw-plugin-session-navigation-test";
customElements.define(tag, SessionNavigationPluginPage);
const sessionKey = "agent:writer:subagent:11111111-2222-4333-8444-555555555555";
const message: ControlUiPluginSessionOpenMessage = {
  type: "openclaw-plugin-session-open",
  sessionKey,
};
const dispose: Array<() => void> = [];

afterEach(() => {
  dispose.splice(0).forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
});

async function mount(
  options: {
    requiresGatewayAuth?: boolean;
    path?: string;
    boardFace?: "dashboard";
  } = {},
) {
  const descriptor: GatewayControlUiPluginTab = {
    pluginId: "example-plugin",
    id: "panel",
    label: "Example panel",
    path: options.path ?? "/plugins/example/panel",
    requiresGatewayAuth: options.requiresGatewayAuth ?? true,
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
    pluginAssetsRequireAuth: true,
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
  const provider = createApplicationContextProvider(context);
  const view = document.createElement(tag) as SessionNavigationPluginPage;
  view.pluginId = descriptor.pluginId;
  view.tabId = descriptor.id;
  provider.append(view);
  document.body.append(provider);
  dispose.push(() => provider.remove());
  await expect.poll(() => view.querySelector("iframe")).not.toBeNull();
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

async function installClickDocument(frame: HTMLIFrameElement) {
  let ready = false;
  const onReady = (event: MessageEvent<unknown>) => {
    if (event.source === frame.contentWindow && event.data === "test-click-ready") {
      ready = true;
    }
  };
  window.addEventListener("message", onReady);
  frame.srcdoc = `<button id="open">Open work session</button><script>
    document.getElementById("open").onclick = () => parent.postMessage(${JSON.stringify(message)}, ${JSON.stringify(window.location.origin)});
    addEventListener("message", event => {
      if (event.source === parent && event.data === "test-click") document.getElementById("open").click();
    });
    parent.postMessage("test-click-ready", ${JSON.stringify(window.location.origin)});
  </script>`;
  try {
    await expect.poll(() => ready).toBe(true);
  } finally {
    window.removeEventListener("message", onReady);
  }
  frame.contentWindow!.postMessage("test-click", "*");
}

describe("authenticated plugin-frame session navigation", () => {
  it("routes a real sandbox-frame click with the canonical base path and ordered selection", async () => {
    const fixture = await mount();
    expect(fixture.frame.getAttribute("sandbox")).toBe("allow-scripts");
    await installClickDocument(fixture.frame);
    await expect.poll(() => fixture.navigate.mock.calls.length).toBe(1);
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
      search: `?__openclawSessionKey=${encodeURIComponent(sessionKey)}`,
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

  it("retires the old window across a coalesced reconnect and after unmount", async () => {
    const fixture = await mount();
    const staleWindow = fixture.frame.contentWindow;
    fixture.snapshot.phase = "reconnecting";
    fixture.notify();
    fixture.snapshot.phase = "connected";
    fixture.notify();
    dispatch(staleWindow);
    expect(fixture.navigate).not.toHaveBeenCalled();
    await expect
      .poll(() => {
        const frame = fixture.view.querySelector("iframe");
        return frame !== null && frame !== fixture.frame;
      })
      .toBe(true);
    await fixture.view.updateComplete;
    const currentFrame = fixture.view.querySelector("iframe")!;
    expect(currentFrame).not.toBe(fixture.frame);
    dispatch(staleWindow);
    expect(fixture.navigate).not.toHaveBeenCalled();
    dispatch(currentFrame.contentWindow);
    expect(fixture.navigate).toHaveBeenCalledOnce();
    const currentWindow = currentFrame.contentWindow;
    fixture.view.remove();
    dispatch(currentWindow);
    expect(fixture.navigate).toHaveBeenCalledOnce();
  });

  it("retires a frame when its descriptor changes and cannot revive it by switching back", async () => {
    const fixture = await mount();
    const staleWindow = fixture.frame.contentWindow;
    fixture.descriptor.path = "/plugins/example/other";
    fixture.view.requestUpdate();
    await expect
      .poll(() => fixture.view.querySelector("iframe")?.getAttribute("src"))
      .toBe("/plugins/example/other");
    fixture.descriptor.path = "/plugins/example/panel";
    fixture.view.requestUpdate();
    await expect
      .poll(() => fixture.view.querySelector("iframe")?.getAttribute("src"))
      .toBe("/plugins/example/panel");
    dispatch(staleWindow);
    expect(fixture.navigate).not.toHaveBeenCalled();
    dispatch(fixture.view.querySelector("iframe")!.contentWindow);
    expect(fixture.navigate).toHaveBeenCalledOnce();
  });

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
