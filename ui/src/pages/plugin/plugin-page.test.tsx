import { createEffect, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginControlUiDiagnostic } from "../../../../packages/gateway-protocol/src/schema/plugins.js";
import {
  CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS,
  CONTROL_UI_PLUGIN_AUTH_PROBE_MESSAGE,
  CONTROL_UI_PLUGIN_AUTH_PROBE_QUERY,
  CONTROL_UI_PLUGIN_AUTH_PROBE_ORIGIN_QUERY,
} from "../../../../src/gateway/control-ui-plugin-frame-contract.js";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type { ApplicationConfigCapability } from "../../app/config.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { getLogbookState, stopLogbookPolling } from "./logbook-controller.ts";
import { BUNDLED_TAB_VIEWS } from "./plugin-page-lifecycle.ts";
import { PluginPage, type PluginPageProps } from "./plugin-page.tsx";

type ApplicationConfig = ApplicationConfigCapability["current"];
const cleanups: Array<() => void> = [];
const probeCalls: string[] = [];
let probeResults: Promise<boolean>[] = [];

async function settle() {
  flush();
  await Promise.resolve();
  flush();
}

function externalPluginConfig(
  pluginFrameGrants: ApplicationConfig["pluginFrameGrants"] = [
    { pluginId: "external-plugin", path: "/plugins/external", match: "prefix" },
  ],
): ApplicationConfig {
  return {
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
    pluginFrameGrants,
  };
}

function createSnapshot(
  hello: GatewayHelloOk,
  client: GatewayBrowserClient | null = null,
): ApplicationGatewaySnapshot {
  return {
    client,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
}

function mountPage(context: ApplicationContext, initial: PluginPageProps) {
  const [props, setProps] = createSignal(initial);
  const provider = createSolidApplicationContextProvider(context);
  const view = mountSolid(
    () => <PluginPage pluginId={props().pluginId} tabId={props().tabId} params={props().params} />,
    { wrapper: provider.wrapper },
  );
  const page = view.container.querySelector("openclaw-plugin-page")!;
  cleanups.push(view.unmount);
  return { page, context, dispose: view.unmount, setProps };
}

function createExternalPluginPage(
  refresh: ApplicationConfigCapability["refresh"],
  requiresGatewayAuth = true,
  path = "/plugins/external/panel",
  options: {
    sessionActions?: string[];
    client?: GatewayBrowserClient;
    contextTokens?: number;
  } = {},
) {
  const hello: GatewayHelloOk = {
    type: "hello-ok",
    protocol: 3,
    auth: { role: "operator", scopes: ["operator.write"] },
    controlUiTabs: [
      {
        pluginId: "external-plugin",
        id: "panel",
        label: "External panel",
        path,
        ...(requiresGatewayAuth ? { requiresGatewayAuth: true } : {}),
        ...(options.sessionActions ? { sessionActions: options.sessionActions } : {}),
      },
    ],
  };
  const snapshot = createSnapshot(hello, options.client);
  const listeners = new Set<() => void>();
  const context = {
    gateway: {
      snapshot,
      connectionRevision: 1,
      subscribe: (notify: () => void) => {
        listeners.add(notify);
        return () => listeners.delete(notify);
      },
    },
    config: { current: externalPluginConfig([]), refresh },
    ...(options.contextTokens === undefined
      ? {}
      : {
          sessions: {
            state: {
              result: { sessions: [{ key: "main", contextTokens: options.contextTokens }] },
            },
          },
        }),
  } as unknown as ApplicationContext;
  return {
    ...mountPage(context, { pluginId: "external-plugin", tabId: "panel" }),
    snapshot,
    notify: () => {
      listeners.forEach((listener) => listener());
      flush();
    },
  };
}

function mockPluginUiDocuments() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response("<!doctype html><html><head></head><body>Plugin panel</body></html>", {
        headers: { "Content-Type": "text/html" },
      }),
  );
}

function pluginUiBridgeNonce(frame: HTMLIFrameElement | null) {
  return frame?.srcdoc.match(/data-openclaw-plugin-ui-nonce="([^"]+)"/u)?.[1];
}

function nextPortMessage(port: MessagePort): Promise<unknown> {
  return new Promise((resolve) => {
    port.addEventListener("message", (event) => resolve(event.data), { once: true });
    port.start();
  });
}

function createHungRenewal() {
  let activeRefreshes = 0;
  let maxActiveRefreshes = 0;
  const refresh = vi
    .fn<ApplicationConfigCapability["refresh"]>()
    .mockResolvedValueOnce(externalPluginConfig())
    .mockImplementation(
      (options) =>
        new Promise<ApplicationConfig | null>((resolve) => {
          activeRefreshes += 1;
          maxActiveRefreshes = Math.max(maxActiveRefreshes, activeRefreshes);
          options?.signal?.addEventListener(
            "abort",
            () => {
              activeRefreshes -= 1;
              resolve(null);
            },
            { once: true },
          );
        }),
    );
  return { refresh, maxActiveRefreshes: () => maxActiveRefreshes };
}

beforeEach(() => {
  vi.stubGlobal("isSecureContext", true);
  probeCalls.length = 0;
  probeResults = [];
  const append = document.body.append.bind(document.body);
  vi.spyOn(document.body, "append").mockImplementation((...nodes) => {
    append(...nodes);
    for (const node of nodes) {
      if (!(node instanceof HTMLIFrameElement)) {
        continue;
      }
      const url = new URL(node.src);
      const nonce = url.searchParams.get(CONTROL_UI_PLUGIN_AUTH_PROBE_QUERY);
      if (!nonce) {
        continue;
      }
      url.searchParams.delete(CONTROL_UI_PLUGIN_AUTH_PROBE_QUERY);
      url.searchParams.delete(CONTROL_UI_PLUGIN_AUTH_PROBE_ORIGIN_QUERY);
      probeCalls.push(url.pathname + url.search + url.hash);
      void (probeResults.shift() ?? Promise.resolve(true)).then((available) => {
        if (available && node.isConnected) {
          window.dispatchEvent(
            new MessageEvent("message", {
              source: node.contentWindow,
              data: { type: CONTROL_UI_PLUGIN_AUTH_PROBE_MESSAGE, nonce },
            }),
          );
        }
      });
    }
  });
});

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("PluginPage", () => {
  it("offers Labs after a custom plugin is blocked, without mistaking a failure for disablement", async () => {
    const pluginId = "custom-review";
    let loading = true;
    const listeners = new Set<() => void>();
    const diagnostics: PluginControlUiDiagnostic[] = [
      { pluginId, message: "Custom plugin UI is off", code: "custom-plugin-ui-disabled" },
    ];
    const plugins = {
      errors: diagnostics,
      registrations: () => [],
      isLoading: () => loading,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const navigate = vi.fn();
    const context = {
      basePath: "/console",
      navigate,
      plugins,
      gateway: { snapshot: { phase: "connected" }, subscribe: () => () => undefined },
    } as unknown as ApplicationContext;
    const fixture = mountPage(context, {
      pluginId,
      tabId: "notes",
      params: { document: "saved-draft" },
    });
    await settle();
    expect(fixture.page.querySelector('[aria-label="Loading…"]')).not.toBeNull();
    expect(fixture.page.textContent).not.toContain("Open Labs");
    loading = false;
    listeners.forEach((listener) => listener());
    await settle();
    expect(fixture.page.textContent).toContain("Custom plugin UI is off");
    expect(fixture.page.params).toEqual({ document: "saved-draft" });
    const link = fixture.page.querySelector<HTMLAnchorElement>('a[href="/console/settings/labs"]');
    expect(link?.textContent?.trim()).toBe("Open Labs");
    link?.click();
    expect(navigate).toHaveBeenCalledExactlyOnceWith("labs");
    plugins.errors = [{ pluginId, message: "Custom plugin UI is off" }];
    listeners.forEach((listener) => listener());
    await settle();
    expect(fixture.page.textContent).toContain("Plugin panel unavailable");
    expect(fixture.page.textContent).toContain("Custom plugin UI is off");
    expect(fixture.page.textContent).not.toContain("Open Labs");
  });

  it("refreshes parent auth before mounting an external plugin frame", async () => {
    const pendingRefresh = createDeferred<ApplicationConfig | null>();
    const pendingProbe = createDeferred<boolean>();
    probeResults = [pendingProbe.promise];
    const refresh = vi.fn(() => pendingRefresh.promise);
    const { page } = createExternalPluginPage(refresh);
    await settle();
    expect(refresh).toHaveBeenCalledOnce();
    expect(page.querySelector("iframe")).toBeNull();
    pendingRefresh.resolve(externalPluginConfig());
    await waitForSolid(() => expect(probeCalls).toEqual(["/plugins/external/panel"]));
    expect(page.querySelector("iframe")).toBeNull();
    pendingProbe.resolve(true);
    await waitForSolid(() =>
      expect(page.querySelector("iframe")?.getAttribute("src")).toBe("/plugins/external/panel"),
    );
  });

  it("uses the development transport for a plugin frame and its auth probe", async () => {
    const basePath = "/openclaw";
    const gatewayUrl = `ws://gateway.example${basePath}`;
    const proxyPath = `/__openclaw_dev_gateway__/${encodeURIComponent(gatewayUrl)}`;
    vi.stubGlobal("OPENCLAW_UI_DEV_GATEWAY", { gatewayUrl, proxyPath });
    const path = `${basePath}/plugins/external/panel?view=activity#settings`;
    const refresh = vi.fn(async () =>
      externalPluginConfig([
        {
          pluginId: "external-plugin",
          path: `${proxyPath}${basePath}/plugins/external`,
          match: "prefix",
        },
      ]),
    );
    const { page } = createExternalPluginPage(refresh, true, path);
    await waitForSolid(() =>
      expect(page.querySelector("iframe")?.getAttribute("src")).toBe(`${proxyPath}${path}`),
    );
    expect(probeCalls).toEqual([`${proxyPath}${path}`]);
  });

  it("keeps the frame unmounted when browser policy blocks the sandbox cookie", async () => {
    vi.useFakeTimers();
    probeResults = [Promise.resolve(false)];
    const { page } = createExternalPluginPage(vi.fn(async () => externalPluginConfig()));
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(page.textContent).toContain("Plugin panel unavailable");
    expect(probeCalls).toEqual(["/plugins/external/panel"]);
    expect(page.querySelector("iframe")).toBeNull();
  });

  it("marks the panel unavailable when bootstrap issued no matching grant", async () => {
    const refresh = vi.fn(async () => externalPluginConfig([]));
    const { page } = createExternalPluginPage(refresh);
    await waitForSolid(() => expect(page.textContent).toContain("Plugin panel unavailable"));
    expect(page.querySelector("iframe")).toBeNull();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("renews external plugin auth before the route-bound grant expires", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => externalPluginConfig());
    const fixture = createExternalPluginPage(refresh);
    await vi.advanceTimersByTimeAsync(0);
    flush();
    expect(refresh).toHaveBeenCalledOnce();
    const frame = fixture.page.querySelector("iframe");
    expect(frame).not.toBeNull();
    await vi.advanceTimersByTimeAsync(CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS / 2);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(fixture.page.querySelector("iframe")).toBe(frame);
    fixture.dispose();
    await vi.advanceTimersByTimeAsync(CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("unmounts an external frame when renewal hangs past grant expiry", async () => {
    vi.useFakeTimers();
    const { refresh, maxActiveRefreshes } = createHungRenewal();
    const { page } = createExternalPluginPage(refresh);
    await vi.advanceTimersByTimeAsync(0);
    flush();
    expect(page.querySelector("iframe")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS / 2);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(page.querySelector("iframe")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS / 2);
    flush();
    expect(page.querySelector("iframe")).toBeNull();
    expect(refresh.mock.calls.length).toBeGreaterThan(2);
    expect(maxActiveRefreshes()).toBe(1);
  });

  it("serially replaces a hung renewal when an expired page resumes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const { refresh, maxActiveRefreshes } = createHungRenewal();
    const { page } = createExternalPluginPage(refresh);
    await vi.advanceTimersByTimeAsync(0);
    flush();
    await vi.advanceTimersByTimeAsync(CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS / 2);
    expect(refresh).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date(CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS));
    window.document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(page.querySelector("iframe")).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(maxActiveRefreshes()).toBe(1);
  });

  it.each([false, true])(
    "refreshes the frame grant after gateway reconnect (bridge: %s)",
    async (bridgeEnabled) => {
      const fetchPluginDocument = bridgeEnabled ? mockPluginUiDocuments() : null;
      const refresh = vi.fn(async () => externalPluginConfig());
      const fixture = createExternalPluginPage(refresh, true, "/plugins/external/panel", {
        sessionActions: bridgeEnabled ? ["list-sessions"] : [],
      });
      await waitForSolid(() => expect(fixture.page.querySelector("iframe")).not.toBeNull());
      const initialFrame = fixture.page.querySelector("iframe");
      const initialWindow = initialFrame?.contentWindow;
      const initialNonce = pluginUiBridgeNonce(initialFrame);
      fixture.snapshot.phase = "stopped";
      fixture.notify();
      expect(fixture.page.querySelector("iframe")).toBeNull();
      fixture.snapshot.phase = "connected";
      fixture.notify();
      await waitForSolid(() => expect(fixture.page.querySelector("iframe")).not.toBeNull());
      expect(refresh).toHaveBeenCalledTimes(2);
      const reconnectedFrame = fixture.page.querySelector("iframe");
      expect(reconnectedFrame).not.toBe(initialFrame);
      expect(reconnectedFrame?.contentWindow).not.toBe(initialWindow);
      if (bridgeEnabled) {
        expect(initialNonce).toMatch(/^[0-9a-f-]{36}$/u);
        expect(pluginUiBridgeNonce(reconnectedFrame)).toMatch(/^[0-9a-f-]{36}$/u);
        expect(pluginUiBridgeNonce(reconnectedFrame)).not.toBe(initialNonce);
        expect(fetchPluginDocument).toHaveBeenCalledTimes(2);
      }
    },
  );

  it("keeps action-capable plugin-auth panels on their direct iframe path", async () => {
    vi.stubGlobal("isSecureContext", false);
    const fetchPluginDocument = vi.spyOn(globalThis, "fetch");
    const refresh = vi.fn(async () => externalPluginConfig());
    const { page } = createExternalPluginPage(refresh, false, "/plugins/external/panel", {
      sessionActions: ["list-sessions"],
    });
    await settle();
    const frame = page.querySelector("iframe");
    expect(frame?.getAttribute("src")).toBe("/plugins/external/panel");
    expect(refresh).not.toHaveBeenCalled();
    expect(fetchPluginDocument).not.toHaveBeenCalled();
    expect(frame?.srcdoc).toBe("");
    expect(pluginUiBridgeNonce(frame)).toBeUndefined();
  });

  it("remounts an action frame and rotates its nonce when its path or sandbox changes", async () => {
    const fetchPluginDocument = mockPluginUiDocuments();
    const fixture = createExternalPluginPage(
      vi.fn(async () => externalPluginConfig()),
      true,
      "/plugins/external/panel",
      { sessionActions: ["list-sessions"] },
    );
    await waitForSolid(() => expect(fixture.page.querySelector("iframe")).not.toBeNull());
    const initialFrame = fixture.page.querySelector("iframe")!;
    const initialWindow = initialFrame.contentWindow;
    const initialNonce = pluginUiBridgeNonce(initialFrame);
    expect(initialNonce).toMatch(/^[0-9a-f-]{36}$/u);
    expect(initialFrame.getAttribute("src")).toBeNull();
    expect(fetchPluginDocument).toHaveBeenCalledWith(
      "/plugins/external/panel",
      expect.objectContaining({ credentials: "include", redirect: "error" }),
    );
    const initialDocument = new DOMParser().parseFromString(initialFrame.srcdoc, "text/html");
    expect(
      initialDocument.head.querySelector("script[data-openclaw-plugin-ui-nonce]"),
    ).not.toBeNull();
    expect(initialDocument.body.textContent).toBe("Plugin panel");

    fixture.snapshot.hello!.controlUiTabs![0]!.path = "/plugins/external/replacement";
    fixture.notify();
    await waitForSolid(() => {
      expect(fixture.page.querySelector("iframe")).not.toBeNull();
      expect(fixture.page.querySelector("iframe")).not.toBe(initialFrame);
    });
    const pathFrame = fixture.page.querySelector("iframe")!;
    const pathWindow = pathFrame.contentWindow;
    const pathNonce = pluginUiBridgeNonce(pathFrame);
    expect(pathWindow).not.toBe(initialWindow);
    expect(pathNonce).toMatch(/^[0-9a-f-]{36}$/u);
    expect(pathNonce).not.toBe(initialNonce);
    expect(pathFrame.srcdoc).toContain(
      `<base href="${new URL("/plugins/external/replacement", window.location.href).href}">`,
    );
    expect(fetchPluginDocument).toHaveBeenCalledWith(
      "/plugins/external/replacement",
      expect.objectContaining({ credentials: "include", redirect: "error" }),
    );

    fixture.context.config.current.embedSandboxMode = "trusted";
    fixture.notify();
    await waitForSolid(() => {
      expect(fixture.page.querySelector("iframe")).not.toBeNull();
      expect(fixture.page.querySelector("iframe")).not.toBe(pathFrame);
    });
    const sandboxFrame = fixture.page.querySelector("iframe")!;
    expect(sandboxFrame.contentWindow).not.toBe(pathWindow);
    expect(sandboxFrame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
    expect(pluginUiBridgeNonce(sandboxFrame)).toMatch(/^[0-9a-f-]{36}$/u);
    expect(pluginUiBridgeNonce(sandboxFrame)).not.toBe(pathNonce);
    expect(fetchPluginDocument).toHaveBeenCalledTimes(3);
  });

  it("does not mount an action bridge when the registered route redirects", async () => {
    const fetchPluginDocument = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("redirect mode is set to error"));
    const { page } = createExternalPluginPage(
      vi.fn(async () => externalPluginConfig()),
      true,
      "/plugins/external/panel",
      { sessionActions: ["list-sessions"] },
    );
    await waitForSolid(() => expect(page.textContent).toContain("Plugin panel unavailable"));
    expect(fetchPluginDocument).toHaveBeenCalledWith(
      "/plugins/external/panel",
      expect.objectContaining({ redirect: "error" }),
    );
    expect(page.querySelector("iframe")).toBeNull();
  });

  it("connects external plugin actions with the trusted gateway session context", async () => {
    mockPluginUiDocuments();
    const request = vi.fn().mockResolvedValue({ sessions: ["main"] });
    const { page } = createExternalPluginPage(
      vi.fn(async () => externalPluginConfig()),
      true,
      "/plugins/external/panel",
      {
        sessionActions: ["list-sessions"],
        client: { request } as unknown as GatewayBrowserClient,
        contextTokens: 64_000,
      },
    );
    await waitForSolid(() => expect(page.querySelector("iframe")).not.toBeNull());
    const frame = page.querySelector("iframe")!;
    const action = new MessageChannel();
    const documentProof = new MessageChannel();
    cleanups.push(() => {
      action.port1.close();
      action.port2.close();
      documentProof.port1.close();
      documentProof.port2.close();
    });
    const connected = nextPortMessage(action.port2);
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { v: 1, type: "openclaw.pluginUi.ready", nonce: pluginUiBridgeNonce(frame) },
        ports: [action.port1, documentProof.port1],
      }),
    );
    expect(await connected).toEqual({
      v: 1,
      type: "openclaw.pluginUi.connect",
      capabilities: { sessionActions: ["list-sessions"] },
      context: { sessionKey: "main", revision: 1, contextTokens: 64_000 },
    });
    const response = nextPortMessage(action.port2);
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- MessagePort has no targetOrigin.
    action.port2.postMessage({
      v: 1,
      type: "openclaw.pluginUi.sessionAction",
      id: "list",
      actionId: "list-sessions",
      contextRevision: 1,
    });
    expect(await response).toEqual({
      v: 1,
      type: "openclaw.pluginUi.response",
      id: "list",
      ok: true,
      result: { sessions: ["main"] },
      contextRevision: 1,
    });
    expect(request).toHaveBeenCalledExactlyOnceWith("plugins.sessionAction", {
      pluginId: "external-plugin",
      actionId: "list-sessions",
      sessionKey: "main",
    });
  });

  it("refuses external plugin auth outside a secure browser context", async () => {
    vi.stubGlobal("isSecureContext", false);
    const refresh = vi.fn(async () => externalPluginConfig());
    const { page } = createExternalPluginPage(refresh);
    await settle();
    expect(refresh).not.toHaveBeenCalled();
    expect(page.querySelector("iframe")).toBeNull();
    expect(page.textContent).toContain("Secure browser context required");
  });

  it("forwards initial and live themes only while the current plugin frame is mounted", async () => {
    vi.stubGlobal("isSecureContext", false);
    document.documentElement.dataset.themeMode = "dark";
    const refresh = vi.fn(async () => externalPluginConfig());
    const fixture = createExternalPluginPage(refresh, false);
    await settle();
    const frame = fixture.page.querySelector<HTMLIFrameElement>("iframe")!;
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame?.getAttribute("src")).toBe("/plugins/external/panel");
    expect(refresh).not.toHaveBeenCalled();
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    frame.dispatchEvent(new Event("load"));
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "openclaw:widget-theme", mode: "dark" }),
      "*",
    );
    postMessage.mockClear();
    document.documentElement.dataset.themeMode = "light";
    await waitForSolid(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "openclaw:widget-theme", mode: "light" }),
        "*",
      ),
    );
    postMessage.mockClear();
    fixture.dispose();
    document.documentElement.dataset.themeMode = "dark";
    frame.dispatchEvent(new Event("load"));
    await settle();
    expect(postMessage).not.toHaveBeenCalled();
    delete document.documentElement.dataset.themeMode;
  });
});

type BundledView = (typeof import("./logbook-view.tsx"))["Logbook"];
function setBundledLoad(load: Promise<BundledView>, stop = stopLogbookPolling) {
  vi.spyOn(BUNDLED_TAB_VIEWS, "logbook/logbook").mockImplementationOnce(async () => ({
    render: await load,
    stop,
  }));
}

function createBundledPage(client: GatewayBrowserClient | null = null, includeExternal = false) {
  const hello: GatewayHelloOk = {
    type: "hello-ok",
    protocol: 3,
    auth: { role: "operator", scopes: ["operator.write"] },
    controlUiTabs: [
      { pluginId: "logbook", id: "logbook", label: "Logbook" },
      ...(includeExternal
        ? [{ pluginId: "external-plugin", id: "panel", label: "External panel" }]
        : []),
    ],
  };
  const snapshot = createSnapshot(hello, client);
  const listeners = new Set<() => void>();
  const context = {
    gateway: {
      snapshot,
      connectionRevision: 1,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    plugins: {
      errors: [],
      registrations: () => [],
      isLoading: () => false,
      subscribe: () => () => undefined,
    },
  } as unknown as ApplicationContext;
  return {
    ...mountPage(context, { pluginId: "logbook", tabId: "logbook" }),
    hello,
    snapshot,
    notify: () => {
      listeners.forEach((listener) => listener());
      flush();
    },
  };
}

function logbookResponse(method: string) {
  if (method === "logbook.status") {
    return {
      captureEnabled: true,
      capturePaused: false,
      captureIntervalSeconds: 30,
      analysisIntervalMinutes: 15,
      retentionDays: 30,
      pendingFrames: 0,
      analysisRunning: false,
      visionModelSource: "missing",
      today: "2026-07-05",
      todayCards: 0,
      timeZone: "UTC",
    };
  }
  if (method === "logbook.days") {
    return { days: [] };
  }
  return {
    day: "2026-07-05",
    cards: [],
    stats: { trackedMs: 0, distractionMs: 0, categories: [], apps: [] },
  };
}

describe("bundled plugin views", () => {
  it("stops a bundled view when its advertised descriptor disappears", async () => {
    const loaded = createDeferred<BundledView>();
    let renderedHost: object | undefined;
    const stop = vi.fn();
    setBundledLoad(loaded.promise, stop);
    const fixture = createBundledPage();
    loaded.resolve((props) => {
      createEffect(
        () => props.host,
        (host) => {
          renderedHost = host;
        },
      );
      return "Logbook view";
    });
    await waitForSolid(() => expect(fixture.page.textContent).toContain("Logbook view"));
    fixture.hello.controlUiTabs = [];
    fixture.notify();
    expect(stop).toHaveBeenCalledWith(renderedHost);
    expect(fixture.page.textContent).not.toContain("Logbook view");
  });

  it("isolates an in-flight bundled load across a same-client reconnect", async () => {
    await import("./logbook-view.tsx");
    vi.setSystemTime(new Date(2026, 6, 5, 12));
    const staleStatus = createDeferred<unknown>();
    const staleDays = createDeferred<unknown>();
    const staleTimeline = createDeferred<unknown>();
    const pending = new Map([
      ["logbook.status", staleStatus],
      ["logbook.days", staleDays],
      ["logbook.timeline", staleTimeline],
    ]);
    const request = vi.fn(
      (method: string) => pending.get(method)?.promise ?? Promise.resolve(logbookResponse(method)),
    );
    const controller = await import("./logbook-controller.ts");
    const stop = vi.spyOn(controller, "stopLogbookPolling");
    const fixture = createBundledPage({ request } as unknown as GatewayBrowserClient);
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(3));
    fixture.snapshot.phase = "stopped";
    fixture.notify();
    const oldHost = stop.mock.calls.at(-1)?.[0];
    expect(oldHost).toBeDefined();
    expect(getLogbookState(oldHost!).pollTimer).toBeNull();
    pending.clear();
    staleStatus.resolve(logbookResponse("logbook.status"));
    staleDays.resolve(logbookResponse("logbook.days"));
    staleTimeline.resolve(logbookResponse("logbook.timeline"));
    await Promise.all([staleStatus.promise, staleDays.promise, staleTimeline.promise]);
    flush();
    expect(fixture.page.querySelector(".logbook__chips")).toBeNull();
    fixture.snapshot.phase = "connected";
    fixture.notify();
    await waitForSolid(() => expect(fixture.page.querySelector(".logbook__chips")).not.toBeNull());
    expect(fixture.page.querySelector(".logbook__day")?.textContent).toBe("2026-07-05");
    expect(request).toHaveBeenCalledTimes(6);
  });

  it("retries the rejected view immediately and recovers without a Gateway update", async () => {
    const failed = createDeferred<BundledView>();
    setBundledLoad(failed.promise);
    const fixture = createBundledPage();
    await settle();
    expect(fixture.page.querySelector('[role="status"]')).not.toBeNull();
    failed.reject(new Error("Logbook chunk failed"));
    await waitForSolid(() =>
      expect(fixture.page.querySelector('[role="alert"]')?.textContent).toContain(
        "Logbook chunk failed",
      ),
    );
    const retry = createDeferred<BundledView>();
    setBundledLoad(retry.promise);
    fixture.page.querySelector<HTMLButtonElement>('[role="alert"] button')?.click();
    await settle();
    expect(fixture.page.querySelector('[role="alert"]')).toBeNull();
    expect(fixture.page.querySelector('[role="status"][aria-label="Loading…"]')).not.toBeNull();
    retry.resolve(() => "recovered Logbook view");
    await waitForSolid(() => expect(fixture.page.textContent).toContain("recovered Logbook view"));
    expect(fixture.page.querySelector('[role="alert"]')).toBeNull();
  });

  it("ignores a stale rejection after switching away and back", async () => {
    const stale = createDeferred<BundledView>();
    setBundledLoad(stale.promise);
    const fixture = createBundledPage(null, true);
    await settle();
    fixture.setProps({ pluginId: "external-plugin", tabId: "panel" });
    await settle();
    const current = createDeferred<BundledView>();
    setBundledLoad(current.promise);
    fixture.setProps({ pluginId: "logbook", tabId: "logbook" });
    await settle();
    current.resolve(() => "current Logbook view");
    await waitForSolid(() => expect(fixture.page.textContent).toContain("current Logbook view"));
    stale.reject(new Error("Failed to fetch dynamically imported module"));
    await settle();
    expect(fixture.page.querySelector('[role="alert"]')).toBeNull();
    expect(fixture.page.textContent).toContain("current Logbook view");
  });
});
