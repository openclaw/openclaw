/* @vitest-environment jsdom */

import type { RouterState } from "@openclaw/uirouter";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { resolveThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { createApplicationRouter, type RouteId } from "../app-routes.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { selectShellRouteState } from "./app-host-route-state.ts";
import {
  createShellOwner,
  mountShellView,
  refreshShellView,
} from "./app-host-solid.test-support.ts";
// This test owns shell panel routing, not lazy sidebar loading; settle that module at setup.
import "../components/app-sidebar.tsx";
import { resetAppHostTestGlobals } from "./app-host.test-support.ts";
import type { ApplicationRuntime } from "./bootstrap.ts";
import type { ApplicationContext } from "./context.ts";
import { loadSettings } from "./settings.ts";

afterEach(async () => {
  await vi.dynamicImportSettled();
  resetAppHostTestGlobals();
});

describe("OpenClaw shell dock suppression", () => {
  it("applies route ownership to shell panels without session-gating desktop", async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
    const client = {} as GatewayBrowserClient;
    const context = {
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
      },
      sessions: {
        state: {
          agentId: "main",
          result: {
            count: 1,
            defaults: {},
            path: "",
            sessions: [
              { key: "agent:main:main", kind: "direct", updatedAt: 0 } satisfies GatewaySessionRow,
            ],
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
    const router = createApplicationRouter();
    onTestFinished(() => router.stop());
    shell.runtime = { context, router } as ApplicationRuntime;
    shell.activeSessionKey = "agent:main:main";
    const container = shell.element;
    const panel = (kind: "assistant" | "terminal" | "desktop") =>
      container.querySelector(`openclaw-${kind}-panel`);
    const expectDesktopAvailable = () =>
      expect(panel("desktop")).toMatchObject({ available: true });
    const expectHomeAvailable = (homeAvailable: boolean, rail = true) => {
      expect(container.querySelector(".shell-chrome-controls__home")).toBeNull();
      if (rail) {
        expect(
          container.querySelector(".shell--navigation-rail openclaw-app-sidebar"),
        ).not.toBeNull();
      }
      expect(panel("assistant")).toMatchObject({ homeAvailable });
    };

    shell.routeState = { routeId: "appearance" };
    mountShellView(shell);
    refreshShellView(shell);
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

    shell.routeState = {
      routeId: "new-session",
      location: { pathname: "/new-session", search: "?agent=missing", hash: "" },
    };
    refreshShellView(shell);
    expect(panel("terminal")).toMatchObject({ agentId: "research" });

    shell.routeState = {
      routeId: "new-session",
      location: { pathname: "/new-session", search: "?agent=main", hash: "" },
    };
    refreshShellView(shell);
    expect(panel("terminal")).toMatchObject({ agentId: "main" });

    context.sessions.state.result!.sessions = [
      {
        key: "agent:main:main",
        kind: "direct",
        placement: { state: "active" } as GatewaySessionRow["placement"],
        updatedAt: 0,
      },
    ];
    refreshShellView(shell);
    expectDesktopAvailable();

    context.sessions.state.result!.sessions = [
      { key: "agent:main:main", kind: "direct", updatedAt: 0 },
    ];
    refreshShellView(shell);
    expectDesktopAvailable();

    context.sessions.state.result = null;
    refreshShellView(shell);
    expectDesktopAvailable();

    // Home now lives in the retained rail, not duplicate floating chrome.
    // The shell still projects its access through permission, reconnect, and Gateway changes.
    expect(container.querySelector(".shell-chrome-controls__custodian")).toBeNull();
    context.navigation.snapshot.navCollapsed = true;
    refreshShellView(shell);
    expect(container.querySelector(".shell-chrome-controls__custodian")).toBeNull();
    expectHomeAvailable(true);
    context.gateway.snapshot.hello!.auth = {
      role: "operator",
      scopes: ["operator.read", "operator.write"],
    };
    refreshShellView(shell);
    expect(container.querySelector(".shell-chrome-controls__custodian")).toBeNull();
    expectHomeAvailable(true);
    context.gateway.snapshot.phase = "offline";
    refreshShellView(shell);
    expectHomeAvailable(true);
    context.gateway.connection.gatewayUrl = "ws://another-gateway.test";
    refreshShellView(shell);
    expectHomeAvailable(false, false);
    context.gateway.snapshot.phase = "connected";
    refreshShellView(shell);
    expectHomeAvailable(true);
    context.gateway.snapshot.hello!.auth = { role: "operator", scopes: ["operator.read"] };
    refreshShellView(shell);
    expect(container.querySelector(".shell-chrome-controls__custodian")).toBeNull();
    expectHomeAvailable(false, false);
    context.gateway.snapshot.phase = "offline";
    refreshShellView(shell);
    expectHomeAvailable(false, false);
  });
});
