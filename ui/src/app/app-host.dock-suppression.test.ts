/* @vitest-environment jsdom */

import type { RouterState } from "@openclaw/uirouter";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { resolveThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { createApplicationRouter, type RouteId } from "../app-routes.ts";
import {
  DESKTOP_PANEL_TOGGLE_EVENT,
  TERMINAL_PANEL_TOGGLE_EVENT,
} from "../components/panel-toggle-contract.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { selectShellRouteState } from "./app-host-route-state.ts";
import {
  createShellOwner,
  connectShellEvents,
  mountShellView,
  refreshShellView,
} from "./app-host-solid.test-support.ts";
// This test owns shell panel routing, not lazy sidebar loading; settle that module at setup.
import "../components/app-sidebar.tsx";
import { resetAppHostTestGlobals } from "./app-host.test-support.ts";
import { readShellView } from "./app-shell-view-state.ts";
import type { ApplicationRuntime } from "./bootstrap.ts";
import type { ApplicationContext } from "./context.ts";
import { loadSettings } from "./settings.ts";

afterEach(async () => {
  await vi.dynamicImportSettled();
  resetAppHostTestGlobals();
});

it("applies route ownership to shell panels without session-gating desktop", async () => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false })),
  );
  const client = createTestGatewayClient(vi.fn());
  const router = createApplicationRouter();
  onTestFinished(() => router.stop());
  const row: GatewaySessionRow = { key: "agent:main:main", kind: "direct", updatedAt: 0 };
  const context = {
    router,
    basePath: "",
    gateway: {
      snapshot: {
        phase: "connected",
        client,
        sessionKey: "agent:main:main",
        assistantAgentId: "main",
        hello: {
          auth: { role: "operator", scopes: ["operator.admin"] },
          features: {
            methods: [
              "terminal.open",
              "browser.request",
              "openclaw.chat",
              "desktop.observe",
              "chat.history",
              "chat.send",
            ],
          },
        },
        lastError: null,
        offlineStable: false,
        selfUser: null,
      },
      connection: { gatewayUrl: "ws://gateway.test", token: "", password: "" },
      connect: vi.fn(),
    },
    agents: {
      state: {
        agentsList: {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [{ id: "main" }, { id: "research" }],
        },
      },
    },
    agentSelection: { state: { selectedId: "research" } },
    agentIdentity: {
      get: () => null,
      entries: () => [],
      ensure: vi.fn(async () => undefined),
      invalidate: vi.fn(),
      subscribe: () => () => undefined,
    },
    settingsAgentSelection: {
      state: { selectedId: "main", scopeId: "main" },
      intentRevision: 0,
      set: vi.fn(),
      setScope: vi.fn(),
      subscribe: () => () => undefined,
    },
    plugins: { selectedReplacement: () => null },
    config: {
      current: { terminalEnabled: true, serverVersion: null, devGitBranch: null },
    },
    runtimeConfig: {
      state: { configSchema: null, configForm: null, configSnapshot: null, configUiHints: null },
      subscribe: () => () => {},
    },
    sessions: {
      state: {
        agentId: "main",
        result: {
          count: 1,
          defaults: {},
          path: "",
          sessions: [row],
          ts: 0,
        },
      },
    },
    navigation: {
      snapshot: {
        navCollapsed: false,
        navWidth: 280,
        sidebarEntries: [],
        pinnedAgentIds: [],
      },
      update: vi.fn(),
    },
    overlays: {
      snapshot: {
        updateAvailable: null,
        updateRunning: false,
        updateStatusBanner: null,
        recordedUpdateAttempt: null,
        controlUiRefreshRequired: false,
        approvalQueue: [],
        approvalBusy: false,
        approvalErrors: new Map(),
        devicePairSetupOpen: false,
        devicePairSetupLifecycle: { phase: "selection", access: "full" },
        devicePairPendingCount: 0,
      },
      runUpdate: vi.fn(),
    },
    theme: { mode: "dark", settings: loadSettings(), branding: resolveThemeBranding({}) },
    preload: vi.fn(),
  } as unknown as ApplicationContext;
  const shell = createShellOwner();
  shell.runtime = { context, router } as ApplicationRuntime;
  shell.activeSessionKey = "agent:main:main";
  const container = shell.element;
  const panel = (kind: "assistant" | "terminal" | "desktop") =>
    container.querySelector(`openclaw-${kind}-panel`);
  const expectHomeAvailable = async (homeAvailable: boolean, rail = true) => {
    refreshShellView(shell);
    await vi.dynamicImportSettled();
    expect(container.querySelector(".shell-chrome-controls__home")).toBeNull();
    expect(container.querySelector(".shell-chrome-controls__custodian")).toBeNull();
    if (rail) {
      expect(
        container.querySelector(".shell--navigation-rail openclaw-app-sidebar"),
      ).not.toBeNull();
    }
    expect(panel("assistant")).toMatchObject({ homeAvailable });
  };

  shell.routeState = { routeId: "appearance" };
  window.history.replaceState(null, "", "/settings/appearance");
  connectShellEvents(shell);
  mountShellView(shell);
  window.dispatchEvent(new CustomEvent(TERMINAL_PANEL_TOGGLE_EVENT));
  window.dispatchEvent(new CustomEvent(DESKTOP_PANEL_TOGGLE_EVENT));
  refreshShellView(shell);
  await vi.dynamicImportSettled();
  await Promise.resolve();
  expect(panel("assistant")).toMatchObject({
    pageRouteId: "appearance",
    custodianSuppressed: false,
  });
  expect(panel("terminal")).toMatchObject({ agentId: "research", suppressed: true });

  shell.routeState = { routeId: "custodian" };
  refreshShellView(shell);
  expect(panel("assistant")).toMatchObject({ custodianSuppressed: true });

  shell.routeState = { routeId: "systems" };
  refreshShellView(shell);
  expect(panel("desktop")).toMatchObject({ suppressed: true });

  shell.routeState = { routeId: "chat" };
  refreshShellView(shell);
  expect(panel("assistant")).toMatchObject({ pageRouteId: "chat" });
  expect(panel("terminal")).toMatchObject({ sessionKey: "agent:main:main" });
  expect(container.querySelector("openclaw-browser-panel")).toBeNull();
  expect(container.querySelector("openclaw-desktop-panel")).toBeNull();

  const failedLocation = { pathname: "/chat/main/missing", search: "", hash: "" };
  shell.routeState = selectShellRouteState({
    matches: [],
    pendingMatches: [
      {
        routeId: "chat",
        location: failedLocation,
        status: "error",
        error: new Error("Unavailable session"),
      },
    ],
  } as unknown as RouterState<RouteId>);
  refreshShellView(shell);
  expect(panel("assistant")).toMatchObject({ pageRouteFailed: true });

  for (const [agent, agentId] of [
    ["missing", "research"],
    ["main", "main"],
  ]) {
    shell.routeState = {
      routeId: "new-session",
      location: { pathname: "/new-session", search: `?agent=${agent}`, hash: "" },
    };
    refreshShellView(shell);
    expect(panel("terminal")).toMatchObject({ agentId });
  }

  for (const result of [
    {
      ...context.sessions.state.result!,
      sessions: [{ ...row, placement: { state: "active" } as GatewaySessionRow["placement"] }],
    },
    { ...context.sessions.state.result!, sessions: [row] },
    null,
  ]) {
    context.sessions.state.result = result;
    refreshShellView(shell);
    expect(panel("desktop")).toMatchObject({ available: true });
  }

  // Home now lives in the retained rail, not duplicate floating chrome.
  // The shell still projects its access through permission, reconnect, and Gateway changes.
  context.navigation.snapshot.navCollapsed = true;
  await expectHomeAvailable(true);
  for (const phase of ["connected", "reconnecting", "offline", "connected"] as const) {
    context.gateway.snapshot.phase = phase;
    refreshShellView(shell);
    expect(readShellView(shell).desktopPanelAvailable).toBe(phase === "connected");
  }
  context.gateway.snapshot.hello!.auth = {
    role: "operator",
    scopes: ["operator.read", "operator.write"],
  };
  await expectHomeAvailable(true);
  context.gateway.snapshot.phase = "offline";
  await expectHomeAvailable(true);
  const acceptedHello = context.gateway.snapshot.hello!;
  context.gateway.connection.gatewayUrl = "ws://another-gateway.test";
  // The Gateway owner clears the previous identity's hello on connection replacement.
  context.gateway.snapshot.hello = null;
  await expectHomeAvailable(false, false);
  context.gateway.snapshot.phase = "connected";
  context.gateway.snapshot.hello = { ...acceptedHello };
  await expectHomeAvailable(true);
  context.gateway.snapshot.hello!.auth = { role: "operator", scopes: ["operator.read"] };
  await expectHomeAvailable(false, false);
  context.gateway.snapshot.phase = "offline";
  await expectHomeAvailable(false, false);
});
