import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginControlUiDiagnostic } from "../../../../packages/gateway-protocol/src/schema/plugins.js";
import { CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS } from "../../../../src/gateway/control-ui-plugin-frame-contract.js";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type { ApplicationConfigCapability } from "../../app/config.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { getLogbookState, stopLogbookPolling } from "./logbook-controller.ts";
import { renderLogbook } from "./logbook-view.ts";
import { PluginPage } from "./plugin-page.ts";

type TestBundledView = {
  render: (props: Parameters<typeof renderLogbook>[0]) => unknown;
  stop: (host: object) => void;
};

type ApplicationConfig = ApplicationConfigCapability["current"];

const logbookBundledView = {
  render: renderLogbook,
  stop: stopLogbookPolling,
} satisfies TestBundledView;

function bundledViewHost(page: PluginPage): object {
  return (page as unknown as { bundledViewHost: object }).bundledViewHost;
}

class DeferredPluginPage extends PluginPage {
  loads = new Map<string, Promise<TestBundledView>[]>();

  protected override loadBundledView(key: string): Promise<TestBundledView> {
    const load = this.loads.get(key)?.shift();
    if (!load) {
      throw new Error(`Unexpected bundled view load: ${key}`);
    }
    return load;
  }
}

class ExternalPluginPage extends PluginPage {
  probeResults: Promise<boolean>[] = [Promise.resolve(true)];
  probeCalls: string[] = [];

  protected override probeExternalTabAuth(path: string, _signal: AbortSignal): Promise<boolean> {
    this.probeCalls.push(path);
    return this.probeResults.shift() ?? Promise.resolve(true);
  }
}

const deferredPluginPageTag = "openclaw-deferred-plugin-page-test";
if (!customElements.get(deferredPluginPageTag)) {
  customElements.define(deferredPluginPageTag, DeferredPluginPage);
}

const externalPluginPageTag = "openclaw-external-plugin-page-test";
if (!customElements.get(externalPluginPageTag)) {
  customElements.define(externalPluginPageTag, ExternalPluginPage);
}

function createBundledPage(loads: Promise<TestBundledView>[], includeExternal = false) {
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
  const snapshot = createSnapshot(hello);
  const page = document.createElement(deferredPluginPageTag) as DeferredPluginPage;
  page.loads = new Map([["logbook/logbook", loads]]);
  page.pluginId = "logbook";
  page.tabId = "logbook";
  (page as unknown as { context: ApplicationContext }).context = {
    gateway: { snapshot, subscribe: () => () => undefined },
    plugins: {
      errors: [],
      registrations: () => [],
      isLoading: () => false,
      subscribe: () => () => undefined,
    },
  } as unknown as ApplicationContext;
  return { page, hello, snapshot };
}

function externalPluginConfig(
  pluginFrameGrants: ApplicationConfig["pluginFrameGrants"] = [
    {
      pluginId: "external-plugin",
      path: "/plugins/external",
      match: "prefix",
    },
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
    remoteImageOrigins: [],
    automaticallyFetchFavicons: false,
    communityInvite: false,
    terminalEnabled: false,
    uploadsEnabled: true,
    pluginAssetsRequireAuth: true,
    pluginFrameGrants,
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

function createExternalPluginPage(
  refresh: ApplicationConfigCapability["refresh"],
  requiresGatewayAuth = true,
  path = "/plugins/external/panel",
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
      },
    ],
  };
  const snapshot = createSnapshot(hello);
  const page = document.createElement(externalPluginPageTag) as ExternalPluginPage;
  page.pluginId = "external-plugin";
  page.tabId = "panel";
  (page as unknown as { context: ApplicationContext }).context = {
    gateway: {
      snapshot,
      subscribe: () => () => undefined,
    },
    config: {
      current: externalPluginConfig([]),
      refresh,
    },
  } as unknown as ApplicationContext;
  return page;
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

describe("PluginPage", () => {
  beforeEach(() => {
    vi.stubGlobal("isSecureContext", true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

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
    const provider = createApplicationContextProvider(context);
    const page = document.createElement("openclaw-plugin-page") as PluginPage;
    page.pluginId = pluginId;
    page.tabId = "notes";
    page.params = { document: "saved-draft" };
    provider.append(page);
    document.body.append(provider);
    try {
      await page.updateComplete;
      expect(page.querySelector('[aria-label="Loading…"]')).not.toBeNull();
      expect(page.textContent).not.toContain("Open Labs");

      loading = false;
      listeners.forEach((listener) => listener());
      await page.updateComplete;
      expect(page.textContent).toContain("Custom plugin UI is off");
      expect(page.params).toEqual({ document: "saved-draft" });
      const link = page.querySelector<HTMLAnchorElement>('a[href="/console/settings/labs"]');
      expect(link?.textContent?.trim()).toBe("Open Labs");
      link?.click();
      expect(navigate).toHaveBeenCalledExactlyOnceWith("labs");

      plugins.errors = [{ pluginId, message: "Custom plugin UI is off" }];
      listeners.forEach((listener) => listener());
      await page.updateComplete;
      expect(page.textContent).toContain("Plugin panel unavailable");
      expect(page.textContent).toContain("Custom plugin UI is off");
      expect(page.textContent).not.toContain("Open Labs");
    } finally {
      provider.remove();
    }
  });

  it("refreshes parent auth before mounting an external plugin frame", async () => {
    const pendingRefresh = createDeferred<ApplicationConfig | null>();
    const pendingProbe = createDeferred<boolean>();
    const refresh = vi.fn(() => pendingRefresh.promise);
    const page = createExternalPluginPage(refresh);
    page.probeResults = [pendingProbe.promise];
    document.body.append(page);
    try {
      await page.updateComplete;
      expect(refresh).toHaveBeenCalledOnce();
      expect(page.querySelector("iframe")).toBeNull();

      pendingRefresh.resolve(externalPluginConfig());
      await waitForFast(() => expect(page.probeCalls).toEqual(["/plugins/external/panel"]));
      expect(page.querySelector("iframe")).toBeNull();

      pendingProbe.resolve(true);
      await waitForFast(() =>
        expect(page.querySelector("iframe")?.getAttribute("src")).toBe("/plugins/external/panel"),
      );
    } finally {
      page.remove();
    }
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
    const page = createExternalPluginPage(refresh, true, path);
    document.body.append(page);
    try {
      await waitForFast(() =>
        expect(page.querySelector("iframe")?.getAttribute("src")).toBe(`${proxyPath}${path}`),
      );
      expect(page.probeCalls).toEqual([`${proxyPath}${path}`]);
    } finally {
      page.remove();
    }
  });

  it("keeps the frame unmounted when browser policy blocks the sandbox cookie", async () => {
    const refresh = vi.fn(async () => externalPluginConfig());
    const page = createExternalPluginPage(refresh);
    page.probeResults = [Promise.resolve(false)];
    document.body.append(page);
    try {
      await waitForFast(() => expect(page.textContent).toContain("Plugin panel unavailable"));
      expect(page.probeCalls).toEqual(["/plugins/external/panel"]);
      expect(page.querySelector("iframe")).toBeNull();
    } finally {
      page.remove();
    }
  });

  it("marks the panel unavailable when bootstrap issued no matching grant", async () => {
    const refresh = vi.fn(async () => externalPluginConfig([]));
    const page = createExternalPluginPage(refresh);
    document.body.append(page);
    try {
      await waitForFast(() => expect(page.textContent).toContain("Plugin panel unavailable"));
      expect(page.querySelector("iframe")).toBeNull();
      expect(refresh).toHaveBeenCalledOnce();
    } finally {
      page.remove();
    }
  });

  it("renews external plugin auth before the route-bound grant expires", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => externalPluginConfig());
    const page = createExternalPluginPage(refresh);
    document.body.append(page);
    try {
      await page.updateComplete;
      await Promise.resolve();
      await page.updateComplete;
      expect(refresh).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS / 2);
      expect(refresh).toHaveBeenCalledTimes(2);

      page.remove();
      await vi.advanceTimersByTimeAsync(CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS);
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      page.remove();
      vi.useRealTimers();
    }
  });

  it("unmounts an external frame when renewal hangs past grant expiry", async () => {
    vi.useFakeTimers();
    const { refresh, maxActiveRefreshes } = createHungRenewal();
    const page = createExternalPluginPage(refresh);
    document.body.append(page);
    try {
      await page.updateComplete;
      await Promise.resolve();
      await page.updateComplete;
      await Promise.resolve();
      await page.updateComplete;
      expect(page.querySelector("iframe")).not.toBeNull();

      await vi.advanceTimersByTimeAsync(CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS / 2);
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(page.querySelector("iframe")).not.toBeNull();

      await vi.advanceTimersByTimeAsync(CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS / 2);
      await page.updateComplete;
      expect(page.querySelector("iframe")).toBeNull();
      expect(refresh.mock.calls.length).toBeGreaterThan(2);
      expect(maxActiveRefreshes()).toBe(1);
    } finally {
      page.remove();
      vi.useRealTimers();
    }
  });

  it("serially replaces a hung renewal when an expired page resumes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const { refresh, maxActiveRefreshes } = createHungRenewal();
    const page = createExternalPluginPage(refresh);
    document.body.append(page);
    try {
      await page.updateComplete;
      await Promise.resolve();
      await page.updateComplete;
      await vi.advanceTimersByTimeAsync(CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS / 2);
      expect(refresh).toHaveBeenCalledTimes(2);

      vi.setSystemTime(new Date(CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS));
      (
        page as unknown as {
          handleVisibilityChange: () => void;
        }
      ).handleVisibilityChange();
      await Promise.resolve();
      await page.updateComplete;

      expect(page.querySelector("iframe")).toBeNull();
      expect(refresh).toHaveBeenCalledTimes(3);
      expect(maxActiveRefreshes()).toBe(1);
    } finally {
      page.remove();
      vi.useRealTimers();
    }
  });

  it("refreshes the frame grant after gateway reconnect", async () => {
    const refresh = vi.fn(async () => externalPluginConfig());
    const page = createExternalPluginPage(refresh);
    document.body.append(page);
    try {
      await waitForFast(() => expect(page.querySelector("iframe")).not.toBeNull());
      const context = (page as unknown as { context: ApplicationContext }).context;
      const gateway = context.gateway;
      const snapshot = gateway.snapshot;

      snapshot.phase = "stopped";
      (
        page as unknown as {
          updateGatewaySource: (source: ApplicationContext["gateway"]) => void;
        }
      ).updateGatewaySource(gateway);
      await page.updateComplete;
      expect(page.querySelector("iframe")).toBeNull();

      snapshot.phase = "connected";
      (
        page as unknown as {
          updateGatewaySource: (source: ApplicationContext["gateway"]) => void;
        }
      ).updateGatewaySource(gateway);
      await waitForFast(() => expect(page.querySelector("iframe")).not.toBeNull());
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      page.remove();
    }
  });

  it("refuses external plugin auth outside a secure browser context", async () => {
    vi.stubGlobal("isSecureContext", false);
    const refresh = vi.fn(async () => externalPluginConfig());
    const page = createExternalPluginPage(refresh);
    document.body.append(page);
    try {
      await page.updateComplete;
      expect(refresh).not.toHaveBeenCalled();
      expect(page.querySelector("iframe")).toBeNull();
      expect(page.textContent).toContain("Secure browser context required");
    } finally {
      page.remove();
    }
  });

  it("forwards initial and live themes only while the current plugin frame is mounted", async () => {
    vi.stubGlobal("isSecureContext", false);
    const refresh = vi.fn(async () => externalPluginConfig());
    const page = createExternalPluginPage(refresh, false);
    document.documentElement.dataset.themeMode = "dark";
    document.body.append(page);
    try {
      await page.updateComplete;
      const frame = page.querySelector<HTMLIFrameElement>("iframe");
      expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
      expect(frame?.getAttribute("src")).toBe("/plugins/external/panel");
      expect(refresh).not.toHaveBeenCalled();
      if (!frame?.contentWindow) {
        throw new Error("Expected the plugin frame to be mounted.");
      }
      const postMessage = vi.spyOn(frame.contentWindow, "postMessage");

      frame.dispatchEvent(new Event("load"));
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "openclaw:widget-theme", mode: "dark" }),
        "*",
      );

      postMessage.mockClear();
      document.documentElement.dataset.themeMode = "light";
      await waitForFast(() =>
        expect(postMessage).toHaveBeenCalledWith(
          expect.objectContaining({ type: "openclaw:widget-theme", mode: "light" }),
          "*",
        ),
      );

      postMessage.mockClear();
      page.remove();
      await page.updateComplete;
      document.documentElement.dataset.themeMode = "dark";
      frame.dispatchEvent(new Event("load"));
      await Promise.resolve();
      expect(postMessage).not.toHaveBeenCalled();
    } finally {
      page.remove();
      delete document.documentElement.dataset.themeMode;
    }
  });

  it("stops a bundled view when its advertised descriptor disappears", async () => {
    const bundledView = createDeferred<TestBundledView>();
    const stop = vi.fn();
    const { page, hello } = createBundledPage([bundledView.promise]);

    document.body.append(page);
    try {
      bundledView.resolve({ render: () => "Logbook view", stop });
      await waitForFast(() => expect(page.textContent).toContain("Logbook view"));
      const previousHost = bundledViewHost(page);

      hello.controlUiTabs = [];
      page.requestUpdate();
      await page.updateComplete;

      expect(bundledViewHost(page)).not.toBe(previousHost);
      expect(stop).toHaveBeenCalledWith(previousHost);
    } finally {
      page.remove();
    }
  });

  it("isolates an in-flight bundled load across a same-client reconnect", async () => {
    const staleStatus = createDeferred<unknown>();
    const staleDays = createDeferred<unknown>();
    const staleTimeline = createDeferred<unknown>();
    const pending = new Map([
      ["logbook.status", staleStatus],
      ["logbook.days", staleDays],
      ["logbook.timeline", staleTimeline],
    ]);
    const request = vi.fn((method: string) => {
      const deferredResponse = pending.get(method);
      return deferredResponse ? deferredResponse.promise : Promise.resolve(logbookResponse(method));
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { page, snapshot } = createBundledPage([Promise.resolve(logbookBundledView)]);
    snapshot.client = client;
    let listener: ((snapshot: ApplicationGatewaySnapshot) => void) | undefined;
    const gateway = {
      snapshot,
      subscribe(next: (snapshot: ApplicationGatewaySnapshot) => void) {
        listener = next;
        return () => {
          if (listener === next) {
            listener = undefined;
          }
        };
      },
    } as unknown as ApplicationContext["gateway"];
    (page as unknown as { context: ApplicationContext }).context = {
      gateway,
    } as unknown as ApplicationContext;
    document.body.append(page);
    try {
      await waitForFast(() => expect(request).toHaveBeenCalledTimes(3));
      const staleHost = bundledViewHost(page);
      expect(getLogbookState(staleHost).pollTimer).not.toBeNull();

      snapshot.phase = "stopped";
      listener?.(snapshot);
      await page.updateComplete;
      const disconnectedHost = bundledViewHost(page);
      expect(disconnectedHost).not.toBe(staleHost);
      expect(getLogbookState(staleHost).pollTimer).toBeNull();

      pending.clear();
      staleStatus.resolve(logbookResponse("logbook.status"));
      staleDays.resolve(logbookResponse("logbook.days"));
      staleTimeline.resolve(logbookResponse("logbook.timeline"));
      await waitForFast(() => expect(getLogbookState(staleHost).timeline).not.toBeNull());
      expect(getLogbookState(disconnectedHost).timeline).toBeNull();

      snapshot.phase = "connected";
      listener?.(snapshot);
      await page.updateComplete;
      expect(bundledViewHost(page)).not.toBe(disconnectedHost);
      await waitForFast(() => expect(getLogbookState(bundledViewHost(page)).status).not.toBeNull());
    } finally {
      page.remove();
    }
  });

  it("shows the current rejection and recovers when Retry succeeds", async () => {
    const failedLoad = createDeferred<TestBundledView>();
    const retryLoad = createDeferred<TestBundledView>();
    const { page } = createBundledPage([failedLoad.promise, retryLoad.promise]);
    document.body.append(page);
    try {
      await waitForFast(() => expect(page.querySelector('[role="status"]')).not.toBeNull());
      failedLoad.reject(new Error("Logbook chunk failed"));
      await waitForFast(() =>
        expect(page.querySelector('[role="alert"]')?.textContent).toContain("Logbook chunk failed"),
      );

      page.querySelector<HTMLButtonElement>('[role="alert"] button')?.click();
      await waitForFast(() => expect(page.querySelector('[role="status"]')).not.toBeNull());
      retryLoad.resolve({ render: () => "recovered Logbook view", stop: vi.fn() });
      await waitForFast(() => expect(page.textContent).toContain("recovered Logbook view"));
      expect(page.querySelector('[role="alert"]')).toBeNull();
    } finally {
      page.remove();
    }
  });

  it("ignores a stale rejection after switching away and back", async () => {
    const staleLoad = createDeferred<TestBundledView>();
    const currentLoad = createDeferred<TestBundledView>();
    const { page } = createBundledPage([staleLoad.promise, currentLoad.promise], true);
    document.body.append(page);
    try {
      await page.updateComplete;
      page.pluginId = "external-plugin";
      page.tabId = "panel";
      await page.updateComplete;
      page.pluginId = "logbook";
      page.tabId = "logbook";
      await page.updateComplete;

      currentLoad.resolve({ render: () => "current Logbook view", stop: vi.fn() });
      await waitForFast(() => expect(page.textContent).toContain("current Logbook view"));
      staleLoad.reject(new Error("Failed to fetch dynamically imported module"));
      await Promise.resolve();
      await page.updateComplete;

      expect(page.querySelector('[role="alert"]')).toBeNull();
      expect(page.textContent).toContain("current Logbook view");
    } finally {
      page.remove();
    }
  });
});
