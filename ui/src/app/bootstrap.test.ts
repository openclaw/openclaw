import type { RouteLocation } from "@openclaw/uirouter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTROL_UI_BASE_PATH_ATTRIBUTE } from "../../../src/gateway/control-ui-contract.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import * as applicationRoutes from "../app-routes.ts";
import { takeGitLabOAuthCallback } from "../features/gitlab-connections/gitlab-oauth-callback.ts";
import * as channelCapabilities from "../lib/channels/index.ts";
import {
  isDefaultChatLanding,
  startModelSetupFirstRunRedirectAfterLocation,
} from "../pages/model-setup/first-run.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { makeLocation, makeRoutingGateway } from "./bootstrap.test-support.ts";
import { bootstrapApplication as createApplication } from "./bootstrap.ts";
import type { ApplicationContext } from "./context.ts";
import * as gatewayStore from "./gateway-store.ts";
import { loadSettings, saveSettings } from "./settings.ts";

// Startup progress (dynamic imports, gateway subscribe, router start) is not a
// performance assertion, so these waits must not inherit vi.waitFor's 1s default:
// under a loaded CI runner that budget expires before startup reaches the step.
const STARTUP_STEP_WAIT = { timeout: 15_000 };
let activeRuntime: ReturnType<typeof createApplication> | undefined;
function bootstrapApplication() {
  return (activeRuntime = createApplication());
}

describe("bootstrapApplication", () => {
  let previousSettings: ReturnType<typeof loadSettings>;
  let previousUrl: string;

  beforeEach(() => {
    previousSettings = loadSettings();
    previousUrl = window.location.href;
  });

  afterEach(() => {
    activeRuntime?.stop();
    activeRuntime = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.history.replaceState({}, "", previousUrl);
    saveSettings(previousSettings);
  });

  function saveSession(sessionKey: string) {
    saveSettings({ ...previousSettings, sessionKey, lastActiveSessionKey: sessionKey });
  }

  function openAt(pathname: string, sessionKey?: string) {
    if (sessionKey) {
      saveSession(sessionKey);
    }
    window.history.replaceState({}, "", pathname);
    return bootstrapApplication();
  }

  it.each(["", "/control"])(
    "captures GitLab callbacks before saved-session routing under %s",
    async (basePath) => {
      document.documentElement.setAttribute(CONTROL_UI_BASE_PATH_ATTRIBUTE, basePath);
      const suffix = "/oauth/gitlab/callback?code=synthetic-secret&state=synthetic-state";
      saveSession("agent:main:main");
      const runtime = openAt(`${basePath}${suffix}`);
      expect(window.location.pathname).toBe(`${basePath}/settings/profile`);
      expect(window.location.search).toBe("");
      expect(takeGitLabOAuthCallback()).toBe(`${window.location.origin}${basePath}${suffix}`);
      expect(takeGitLabOAuthCallback()).toBeNull();
      expect(runtime.router.getState().location.pathname).not.toContain("chat");
      document.documentElement.removeAttribute(CONTROL_UI_BASE_PATH_ATTRIBUTE);
    },
  );

  it("owns one Channels capability only after first use and rejects acquisition after stop", async () => {
    const createChannels = vi.spyOn(channelCapabilities, "createChannelCapability");
    const runtime = openAt("/chat/main/example-deadbeef");
    const gateway = runtime.context.gateway;
    expect(createChannels).not.toHaveBeenCalled();

    // First route use must observe the current connection, not the startup snapshot.
    const request = vi.fn(async () => null);
    const currentSnapshot = {
      ...gateway.snapshot,
      client: createTestGatewayClient(request),
      phase: "connected" as const,
    };
    vi.spyOn(gateway, "snapshot", "get").mockReturnValue(currentSnapshot);
    const channels = runtime.context.acquireChannels(createChannels);
    expect(channels.state.connected).toBe(true);
    expect(runtime.context.acquireChannels(createChannels)).toBe(channels);
    expect(createChannels).toHaveBeenCalledExactlyOnceWith(gateway);
    await channels.refresh();
    expect(request).toHaveBeenCalledOnce();

    runtime.stop();
    runtime.stop();
    await channels.refresh();
    expect(request).toHaveBeenCalledOnce();
    expect(() => runtime.context.acquireChannels(createChannels)).toThrow();
    expect(createChannels).toHaveBeenCalledOnce();

    const unused = bootstrapApplication();
    unused.stop();
    expect(() => unused.context.acquireChannels(createChannels)).toThrow();
    expect(createChannels).toHaveBeenCalledOnce();
  });

  it.each(["chat", "dashboard"])(
    "gives the initial %s transcript priority over bulk reads",
    async (face) => {
      window.history.replaceState({}, "", `/${face}/main/mission-control-12345678`);
      const runtime = bootstrapApplication();
      const read = vi.fn(async () => {});
      runtime.context.connectionBootstrap.synchronize({ client: {}, connected: true });
      const pending = runtime.context.connectionBootstrap.run("bulk", read, { background: true });
      expect(read).not.toHaveBeenCalled();
      runtime.context.connectionBootstrap.setForegroundRoute(null);
      await pending;
      expect(read).toHaveBeenCalledOnce();
    },
  );

  it("owns native health reporting across startup and stop", async () => {
    window.history.replaceState({}, "", "/focus/terminal");
    const postMessage = vi.fn();
    vi.stubGlobal("webkit", { messageHandlers: { openclawGateways: { postMessage } } });
    const changed = vi.fn();
    window.addEventListener("openclaw:native-gateway-health-changed", changed);
    const runtime = bootstrapApplication();
    const startGateway = vi.spyOn(runtime.context.gateway, "start").mockImplementation(() => {
      expect(Reflect.get(window, "__OPENCLAW_NATIVE_GATEWAY_HEALTH__")).toEqual({
        gatewayUrl: runtime.context.gateway.connection.gatewayUrl,
        health: "unknown",
      });
    });
    try {
      await runtime.start();
      expect(startGateway).toHaveBeenCalledOnce();
      expect(changed).toHaveBeenCalledOnce();
      // The shared Linux bridge must not receive a Mac-only action.
      expect(postMessage).not.toHaveBeenCalled();
      runtime.stop();
      expect(Reflect.get(window, "__OPENCLAW_NATIVE_GATEWAY_HEALTH__")).toMatchObject({
        health: "unknown",
      });
    } finally {
      runtime.stop();
      window.removeEventListener("openclaw:native-gateway-health-changed", changed);
      Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_GATEWAY_HEALTH__");
    }
  });

  it("starts native notifications before Gateway use", async () => {
    const postMessage = vi.fn();
    vi.stubGlobal("webkit", { messageHandlers: { openclawNotifications: { postMessage } } });
    vi.stubGlobal("__OPENCLAW_NATIVE_NOTIFICATIONS__", { permission: "notDetermined" });
    const runtime = openAt("/focus/terminal");
    const startGateway = vi.spyOn(runtime.context.gateway, "start").mockImplementation(() => {
      expect(runtime.context.nativeNotifications?.snapshot.permission).toBe("notDetermined");
      expect(postMessage).toHaveBeenCalledWith({ type: "status" });
    });
    expect(postMessage).not.toHaveBeenCalled();
    await runtime.start();
    expect(startGateway).toHaveBeenCalledOnce();
  });

  it("does not install native notification listeners when stop wins startup", async () => {
    window.history.replaceState({}, "", "/focus/terminal");
    const postMessage = vi.fn();
    vi.stubGlobal("webkit", { messageHandlers: { openclawNotifications: { postMessage } } });
    const runtime = bootstrapApplication();
    const starting = runtime.start();
    runtime.stop();
    await starting;
    window.dispatchEvent(new Event("focus"));
    expect(postMessage).not.toHaveBeenCalled();
    expect(runtime.context.nativeNotifications).toBeNull();
  });

  it.each([
    { pathname: "/chat/main/example-deadbeef", routeId: "chat", warmed: true },
    { pathname: "/dashboard/main/example-deadbeef", routeId: "dashboard", warmed: true },
    { pathname: "/", routeId: "chat", warmed: false },
    { pathname: "/chat", routeId: "chat", warmed: false },
    { pathname: "/chat/main", routeId: "chat", warmed: false },
    { pathname: "/approve/exec%3A1", routeId: "chat", warmed: false },
  ] as const)(
    "warms only explicit application routes during bootstrap before start: $pathname",
    async ({ pathname, routeId, warmed }) => {
      window.history.replaceState({}, "", pathname);
      const router = applicationRoutes.createApplicationRouter();
      const route = router.getRoute(routeId);
      if (!route) {
        throw new Error(`Missing route ${routeId}`);
      }
      const component = vi.spyOn(route, "component").mockResolvedValue({ renderSolid: () => null });
      const loader = vi.spyOn(route, "loader");
      vi.spyOn(applicationRoutes, "createApplicationRouter").mockReturnValue(router);
      const runtime = bootstrapApplication();
      vi.spyOn(runtime.context.gateway, "start").mockImplementation(() => {});
      expect(component).toHaveBeenCalledTimes(warmed ? 1 : 0);
      expect(loader).not.toHaveBeenCalled();
      const starting = runtime.start();
      expect(component).toHaveBeenCalledTimes(warmed ? 1 : 0);
      expect(loader).not.toHaveBeenCalled();
      runtime.stop();
      await starting;
      component.mockClear();
      await runtime.start();
      expect(component).not.toHaveBeenCalled();
    },
  );

  it("starts the first-run redirect after installing the persisted session location", async () => {
    const { promise: initialLocationReady, resolve: resolveInitialLocation } =
      createDeferred<RouteLocation>();
    let currentLocation = makeLocation();
    const replaceLocation = vi.fn((location: RouteLocation) => {
      currentLocation = location;
    });
    const request = vi.fn().mockResolvedValue({
      candidates: [],
      manualProviders: [],
      workspace: "/tmp/workspace",
      setupComplete: false,
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const replaceRoute = vi.fn();
    const routing = makeRoutingGateway({ phase: "connecting", client: null });
    const { gateway } = routing;
    const context = {
      gateway,
      agentSelection: {
        state: { selectedId: "main" },
        subscribe: () => () => undefined,
      },
      replace: replaceRoute,
    } as unknown as ApplicationContext;
    const canonicalLocation = makeLocation("/chat/main");

    const redirectReady = startModelSetupFirstRunRedirectAfterLocation({
      context,
      enabled: true,
      history: { location: () => currentLocation, replace: replaceLocation },
      initialLocationReady,
    });
    expect(gateway.subscribe).not.toHaveBeenCalled();

    resolveInitialLocation(canonicalLocation);
    await redirectReady;
    expect(replaceLocation).toHaveBeenCalledWith(canonicalLocation);
    expect(gateway.subscribe).toHaveBeenCalledOnce();
    routing.publish({
      phase: "connected",
      client,
      hello: {
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: ["openclaw.setup.detect"] },
        snapshot: {
          sessionDefaults: { defaultAgentId: "main", modelConfigured: false },
        },
      },
    });
    expect(request).not.toHaveBeenCalled();
    expect(replaceRoute).toHaveBeenCalledOnce();
    expect(replaceRoute).toHaveBeenCalledWith("model-setup", { search: "?firstRun=1" });
  });

  it("does not replace a user route with the deferred default chat location", async () => {
    const currentLocation = makeLocation("/new");
    const installLocation = vi.fn();

    await startModelSetupFirstRunRedirectAfterLocation({
      context: {} as ApplicationContext,
      enabled: false,
      history: { location: () => currentLocation, replace: vi.fn() },
      initialLocationReady: Promise.resolve(makeLocation("/chat/main")),
      installLocation,
      shouldInstallLocation: () =>
        isDefaultChatLanding(currentLocation, "", applicationRoutes.routeIdFromPath),
    });

    expect(installLocation).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "bootstrap token on the deferred default landing",
      initialUrl: "/?keep=yes#bootstrapToken=boot-default&bootstrapProfile=owner&tab=keep",
      expectedUrl: "/?keep=yes#tab=keep",
      expectedBootstrapToken: "boot-default",
      expectedBootstrapProfile: "owner",
      expectedToken: "",
    },
    {
      name: "legacy fragment token and discarded query password",
      initialUrl: "/settings/appearance?keep=yes&password=discard#token=shared-fragment&tab=keep",
      expectedUrl: "/settings/appearance?keep=yes#tab=keep",
      expectedBootstrapToken: "",
      expectedBootstrapProfile: undefined,
      expectedToken: "shared-fragment",
    },
    {
      name: "legacy query token and discarded fragment password",
      initialUrl: "/settings/appearance?keep=yes&token=shared-query#password=discard&tab=keep",
      expectedUrl: "/settings/appearance?keep=yes#tab=keep",
      expectedBootstrapToken: "",
      expectedBootstrapProfile: undefined,
      expectedToken: "shared-query",
    },
  ])("synchronously removes $name while preserving Gateway authentication", (testCase) => {
    saveSettings({
      ...previousSettings,
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
    });
    window.history.replaceState({}, "", testCase.initialUrl);
    const replaceState = vi.spyOn(window.history, "replaceState");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runtime = bootstrapApplication();

    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(
      testCase.expectedUrl,
    );
    expect(replaceState).toHaveBeenCalledExactlyOnceWith({}, "", testCase.expectedUrl);
    expect(runtime.context.gateway.connection).toMatchObject({
      bootstrapToken: testCase.expectedBootstrapToken,
      token: testCase.expectedToken,
    });
    expect(runtime.context.gateway.connection.bootstrapProfile).toBe(
      testCase.expectedBootstrapProfile,
    );
    expect(runtime).toMatchObject({
      documentMode: null,
      context: { gateway: { snapshot: { phase: "stopped" } } },
    });
  });

  it("keeps an inferred route namespace separate from the root resource mount", async () => {
    const previousResourceBasePath = document.documentElement.getAttribute(
      CONTROL_UI_BASE_PATH_ATTRIBUTE,
    );
    saveSession("agent:main:main");
    document.documentElement.setAttribute(CONTROL_UI_BASE_PATH_ATTRIBUTE, "");
    const runtime = openAt("/__openclaw__/new");

    try {
      await runtime.start();

      expect(runtime.context.basePath).toBe("/__openclaw__");
      expect(runtime.context.resourceBasePath).toBe("");
      expect(runtime.router.getState().matches[0]?.routeId).toBe("new-session");
      expect(window.location.pathname).toBe("/__openclaw__/new");
    } finally {
      runtime.stop();
      if (previousResourceBasePath === null) {
        document.documentElement.removeAttribute(CONTROL_UI_BASE_PATH_ATTRIBUTE);
      } else {
        document.documentElement.setAttribute(
          CONTROL_UI_BASE_PATH_ATTRIBUTE,
          previousResourceBasePath,
        );
      }
    }
  });

  it("rewrites the released terminal query at the application boundary", async () => {
    window.history.replaceState({}, "", "/openclaw/?view=terminal&keep=yes#pane");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const runtime = bootstrapApplication();
    const routerStart = vi.spyOn(runtime.router, "start");
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(
      "/openclaw/focus/terminal?keep=yes#pane",
    );
    expect(runtime.focusLocation).toEqual({
      status: "valid",
      basePath: "/openclaw",
      target: { kind: "terminal" },
    });
    await runtime.start();
    expect(routerStart).not.toHaveBeenCalled();
    expect(replaceState).toHaveBeenCalledTimes(1);
  });

  it("strips startup credentials before rewriting the released terminal query", () => {
    window.history.replaceState({}, "", "/?view=terminal#token=startup-token&pane=1");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const runtime = bootstrapApplication();

    expect(replaceState.mock.calls.map((call) => call[2])).toEqual([
      "/?view=terminal#pane=1",
      "/focus/terminal#pane=1",
    ]);
    expect(runtime.focusLocation).toEqual({
      status: "valid",
      basePath: "",
      target: { kind: "terminal" },
    });
  });

  it("keeps the latest navigation requested before router start", async () => {
    const runtime = openAt("/chat", "agent:main:main");
    const pushState = vi.spyOn(window.history, "pushState");

    const start = runtime.start();
    runtime.context.replace("about");
    runtime.context.navigate("new-session");
    expect(window.location.pathname).toBe("/chat");

    await start;

    expect(runtime.router.getState().matches[0]?.routeId).toBe("new-session");
    expect(runtime.router.getState().resolvedLocation?.pathname).toBe("/new");
    expect(window.location.pathname).toBe("/new");
    expect(pushState).toHaveBeenCalledWith({}, "", "/new");
  });

  it("replaces instead of pushing when re-navigating to the active location", async () => {
    const runtime = openAt("/settings/appearance", "main");
    const pushState = vi.spyOn(window.history, "pushState");
    const replaceState = vi.spyOn(window.history, "replaceState");

    await runtime.start();
    await runtime.context.navigateAndWait("about");
    expect(pushState).toHaveBeenCalledWith({}, "", "/settings/about");
    pushState.mockClear();
    replaceState.mockClear();

    // Re-clicking the active nav item: no new history entry, Back stays live.
    await runtime.context.navigateAndWait("about");

    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).toHaveBeenCalledWith({}, "", "/settings/about");
  });

  it("consumes an unscoped initial-location abort after stop wins early startup", async () => {
    const runtime = openAt("/", "main");
    const unhandledRejection = vi.fn((event: PromiseRejectionEvent) => event.preventDefault());
    const routerStart = vi.spyOn(runtime.router, "start");
    const redirectSubscription = vi.spyOn(runtime.context.gateway, "subscribe");
    window.addEventListener("unhandledrejection", unhandledRejection);

    try {
      const start = runtime.start();
      runtime.stop();
      await expect(start).resolves.toBeUndefined();
      await Promise.resolve();

      expect(unhandledRejection).not.toHaveBeenCalled();
      expect(routerStart).not.toHaveBeenCalled();
      expect(redirectSubscription).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("unhandledrejection", unhandledRejection);
      runtime.stop();
    }
  });

  it("stops a cold released-link startup without leaking its readiness subscription", async () => {
    saveSession("agent:main:main");
    window.history.replaceState({}, "", "/chat?session=agent%3Aresearch%3Aworkspace");
    type GatewayListener = Parameters<ApplicationContext["gateway"]["subscribe"]>[0];
    const activeSubscriptions = new Set<GatewayListener>();
    const createGateway = gatewayStore.createApplicationGateway;
    vi.spyOn(gatewayStore, "createApplicationGateway").mockImplementation((...args) => {
      const gateway = createGateway(...args);
      const subscribe = gateway.subscribe;
      // The released-link resolver subscribes during construction. Keep the
      // real owner cold and track its subscriptions before bootstrap sees it.
      vi.spyOn(gateway, "start").mockImplementation(() => {});
      vi.spyOn(gateway, "subscribe").mockImplementation((listener) => {
        activeSubscriptions.add(listener);
        const unsubscribe = subscribe(listener);
        return () => {
          activeSubscriptions.delete(listener);
          unsubscribe();
        };
      });
      return gateway;
    });
    const runtime = bootstrapApplication();
    const constructionSubscriptions = new Set(activeSubscriptions);
    const readinessSubscriptions = new Set<GatewayListener>();
    const signal = runtime.context.lifecycleAbortSignal;
    if (!signal) {
      throw new Error("expected application lifecycle signal");
    }
    signal.addEventListener("abort", () => {
      // Readiness retires on abort, before the other application disposers run.
      for (const listener of constructionSubscriptions) {
        if (!activeSubscriptions.has(listener)) {
          readinessSubscriptions.add(listener);
        }
      }
    });
    const routerStart = vi.spyOn(runtime.router, "start");
    const configRefresh = vi.spyOn(runtime.context.config, "refresh");

    const start = runtime.start();
    await Promise.resolve();
    expect(runtime.context.gateway.snapshot.phase).toBe("stopped");
    runtime.stop();
    await start;

    expect(readinessSubscriptions.size).toBe(1);
    expect(
      [...readinessSubscriptions].filter((listener) => activeSubscriptions.has(listener)),
    ).toHaveLength(0);
    expect(configRefresh).toHaveBeenCalledWith({ ifNeeded: true, signal });
    expect(routerStart).not.toHaveBeenCalled();
  });

  it("stops the router immediately and again after an in-flight start settles", async () => {
    const runtime = openAt("/settings/appearance", "main");
    const routerStarted = createDeferred();
    const routerStart = vi.spyOn(runtime.router, "start").mockReturnValue(routerStarted.promise);
    const routerStop = vi.spyOn(runtime.router, "stop");

    const start = runtime.start();
    await vi.waitFor(() => expect(routerStart).toHaveBeenCalledOnce(), STARTUP_STEP_WAIT);
    runtime.stop();
    expect(routerStop).toHaveBeenCalledOnce();

    routerStarted.resolve();
    await start;
    expect(routerStop).toHaveBeenCalledTimes(2);
  });

  it("resolves runtime startup when the initial route is not found", async () => {
    const runtime = openAt("/settings/about", "main");
    const routerStart = vi
      .spyOn(runtime.router, "start")
      .mockRejectedValue({ type: "notFound", data: { routeId: "chat" } });

    await expect(runtime.start()).resolves.toBeUndefined();
    expect(routerStart).toHaveBeenCalledOnce();
  });

  it("applies and refreshes the saved accent before the gateway connects", () => {
    saveSettings({ ...previousSettings, accent: "#48D6C2" });
    const runtime = bootstrapApplication();

    try {
      expect(runtime.context.gateway.snapshot.phase).toBe("stopped");
      expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#48d6c2");
      expect(runtime.context.theme.settings.accent).toBe("#48d6c2");

      saveSettings({ ...loadSettings(), accent: "#f4b740" });
      expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#f4b740");
      expect(runtime.context.theme.settings.accent).toBe("#f4b740");
    } finally {
      saveSettings(previousSettings);
      runtime.context.theme.refresh();
      runtime.stop();
    }
  });

  it("releases browser chrome breakpoint listeners on stop", () => {
    const listeners = new Set<() => void>();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        addEventListener: (_: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
      })),
    );
    const runtime = bootstrapApplication();
    expect(listeners.size).toBeGreaterThan(0);
    runtime.stop();
    expect(listeners.size).toBe(0);
  });
});
